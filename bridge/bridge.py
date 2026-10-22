#!/usr/bin/env python3
"""The bambu mod's bridge: follows a Bambu Lab printer through Bambu Lab's cloud.

The mod starts it with stdin closed and reads stdout, one JSON object per line:

    {"view": {...}, "commands": "<folder>"}   the printer, ready to draw (types/index.d.ts)
    {"toast": "..."} or {"error": "..."}       how a command went

Commands are files the mod drops into that folder, {"cmd": "<name>"} each:
sign-in, sign-out, light, pause, resume, stop, refresh.

Sign-in asks for the email, the password (a hidden field) and any code Bambu sends in
macOS dialogs, so the password never passes through the mod and is never stored. The
tokens Bambu answers with go to the Keychain, service "claude-bambu".

BAMBU_REGION ("china" for a bambulab.cn account) and BAMBU_PRINTER (a name or the end of a
serial) come from the mod's settings. BAMBU_FIXTURE=<file.jsonl> plays recorded MQTT
messages, one per line, instead of signing in.

Standard library only, for the python3 that ships with macOS.
"""

import calendar
import hashlib
import http.cookies
import json
import os
import re
import secrets
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

ROOT = os.path.join(os.path.expanduser("~"), "Library", "Application Support", "claude-bambu")
COMMANDS = os.path.join(ROOT, "commands")
COVERS = os.path.join(ROOT, "covers")
STATE_FILE = os.path.join(ROOT, "state.json")
HMS_FILE = os.path.join(ROOT, "hms-tables.json")
LOG_FILE = os.path.join(ROOT, "bridge.log")
KEYCHAIN = "claude-bambu"

CLOUDS = {
    "global": {"api": "https://api.bambulab.com", "web": "https://bambulab.com", "mqtt": "us.mqtt.bambulab.com"},
    "china": {"api": "https://api.bambulab.cn", "web": "https://bambulab.cn", "mqtt": "cn.mqtt.bambulab.com"},
}
HMS_URL = "https://e.bambulab.com/query.php?lang=en"

# Bambu's API serves slicers, so the requests introduce themselves the way a slicer's network agent does.
HEADERS = {
    "User-Agent": "bambu_network_agent/01.09.05.01",
    "X-BBL-Client-Name": "OrcaSlicer",
    "X-BBL-Client-Type": "slicer",
    "X-BBL-Client-Version": "01.09.05.51",
    "X-BBL-Language": "en-US",
    "Content-Type": "application/json",
    "Accept": "application/json",
}

FIXTURE = os.environ.get("BAMBU_FIXTURE") or ""
REGION = "china" if (os.environ.get("BAMBU_REGION") or "").lower() == "china" else "global"
WANTED_PRINTER = (os.environ.get("BAMBU_PRINTER") or "").strip().lower()

ACTIVE_STATES = {"PREPARE", "RUNNING", "PAUSE", "SLICING", "INIT"}
SPEEDS = {1: "Silent", 3: "Sport", 4: "Ludicrous"}
STAGES = {
    1: "Leveling the bed", 2: "Heating the bed", 3: "Vibration compensation", 4: "Changing filament",
    5: "Paused (M400)", 6: "Paused: out of filament", 7: "Heating the nozzle", 8: "Calibrating extrusion",
    9: "Scanning the bed", 10: "Checking the first layer", 11: "Identifying the plate",
    12: "Calibrating the lidar", 13: "Homing", 14: "Cleaning the nozzle", 15: "Checking the extruder",
    16: "Paused by you", 17: "Paused: the front cover is off", 18: "Calibrating the lidar",
    19: "Calibrating the flow", 20: "Paused: nozzle temperature", 21: "Paused: bed temperature",
    22: "Unloading filament", 23: "Paused: a skipped step", 24: "Loading filament",
    25: "Calibrating motor noise", 26: "Paused: the AMS is lost", 27: "Paused: heatbreak fan",
    28: "Paused: chamber temperature", 29: "Cooling the chamber", 30: "Paused by G-code",
    31: "Motor noise showoff", 32: "Paused: filament on the nozzle", 33: "Paused: cutter",
    34: "Paused: first layer", 35: "Paused: nozzle clog",
}

KEEPALIVE = 60          # seconds, MQTT
QUIET_PUSHALL = 300     # seconds without a report before asking for everything again
DEVICES_EVERY = 600     # seconds between bound-printer lists
TASKS_EVERY = 600       # seconds between task lists, besides job changes

out_lock = threading.Lock()
changed = threading.Event()
stopping = threading.Event()


def log(*parts):
    """A small log file for troubleshooting; never tokens, passwords or serials."""
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 256 * 1024:
            os.replace(LOG_FILE, LOG_FILE + ".1")
        with open(LOG_FILE, "a") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), " ".join(str(p) for p in parts)))
    except OSError:
        pass


def emit(message):
    try:
        with out_lock:
            sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    except OSError:
        os._exit(0)  # the mod went away


def background(fn, *args):
    threading.Thread(target=fn, args=args, daemon=True).start()


class Problem(Exception):
    """Something to show the person as is."""


# ---------------------------------------------------------------- saved state


class Saved:
    """state.json: the account's email, cloud and uid, and the printers and tasks last seen."""

    def __init__(self):
        self.lock = threading.Lock()
        self.data = {"email": "", "cloud": REGION, "uid": "", "devices": [], "tasks": {}}
        try:
            with open(STATE_FILE) as f:
                self.data.update(json.load(f))
        except (OSError, ValueError):
            pass

    def get(self, key):
        with self.lock:
            return self.data.get(key)

    def put(self, **values):
        with self.lock:
            self.data.update(values)
            text = json.dumps(self.data, indent=1)
        try:
            with open(STATE_FILE + ".tmp", "w") as f:
                f.write(text)
            os.chmod(STATE_FILE + ".tmp", 0o600)
            os.replace(STATE_FILE + ".tmp", STATE_FILE)
        except OSError as e:
            log("state:", e)


saved = None  # Saved, made in main()


# ---------------------------------------------------------------- Keychain


def keychain_get(account):
    r = subprocess.run(["security", "find-generic-password", "-s", KEYCHAIN, "-a", account, "-w"],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def keychain_set(account, secret):
    if not re.fullmatch(r"[A-Za-z0-9._~+/=-]+", secret):
        raise Problem("Bambu answered with a token this bridge can't store")
    # Through security's own prompt rather than its arguments, so the token never shows in `ps`.
    command = 'add-generic-password -U -s %s -a %s -l "Bambu Lab %s token" -w "%s"\n' % (KEYCHAIN, account, account, secret)
    r = subprocess.run(["security", "-i"], input=command, capture_output=True, text=True)
    if r.returncode != 0:
        raise Problem("Couldn't save the sign-in to the Keychain")


def keychain_delete(account):
    subprocess.run(["security", "delete-generic-password", "-s", KEYCHAIN, "-a", account], capture_output=True)


# ---------------------------------------------------------------- Bambu's cloud API


class Cloud:
    def __init__(self):
        self.lock = threading.Lock()
        self.access = keychain_get("access")
        self.refresh = keychain_get("refresh")
        self.signed_out = ""

    @property
    def urls(self):
        return CLOUDS[saved.get("cloud") or REGION]

    def signed_in(self):
        return bool(self.access)

    def keep(self, access, refresh):
        keychain_set("access", access)
        if refresh:
            keychain_set("refresh", refresh)
        with self.lock:
            self.access, self.refresh, self.signed_out = access, refresh or self.refresh, ""

    def forget(self, reason=""):
        keychain_delete("access")
        keychain_delete("refresh")
        with self.lock:
            self.access, self.refresh, self.signed_out = "", "", reason
        changed.set()

    def renew(self, stale):
        """New tokens after a 401: another session's bridge may have renewed already, else trade the refresh token."""
        with self.lock:
            fresh = keychain_get("access")
            if fresh and fresh != stale:
                self.access, self.refresh = fresh, keychain_get("refresh") or self.refresh
                return True
            refresh = self.refresh
        if not refresh:
            return False
        status, answer, _ = self.call("POST", "/v1/user-service/user/refreshtoken", {"refreshToken": refresh}, signed=False)
        if status != 200 or not answer.get("accessToken"):
            log("renew: HTTP", status)
            return False
        self.keep(answer["accessToken"], answer.get("refreshToken") or "")
        log("renew: new tokens")
        return True

    def call(self, method, path, body=None, signed=True, url=None, again=True):
        """(status, JSON answer, headers); a 401 renews the tokens once."""
        url = url or self.urls["api"] + path
        headers = dict(HEADERS)
        token = self.access
        if signed:
            if not token:
                raise Problem("Not signed in to Bambu Lab")
            headers["Authorization"] = "Bearer " + token
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                status, raw, got = response.status, response.read(), response.headers
        except urllib.error.HTTPError as e:
            status, raw, got = e.code, e.read(), e.headers
        except (urllib.error.URLError, OSError) as e:
            raise Problem("Can't reach Bambu Lab's cloud") from e
        try:
            answer = json.loads(raw or b"{}")
        except ValueError:
            answer = {}
        if not isinstance(answer, dict):
            answer = {"items": answer}
        if status == 401 and signed and again:
            if self.renew(token):
                return self.call(method, path, body, signed, url, again=False)
            self.forget("Bambu Lab signed this bridge out; sign in again")
            raise Problem("Bambu Lab signed this bridge out; sign in again")
        return status, answer, got

    def get(self, path):
        status, answer, _ = self.call("GET", path)
        if status != 200:
            raise Problem("Bambu Lab's cloud answered %d" % status)
        return answer


cloud = None  # Cloud, made in main()


# ---------------------------------------------------------------- signing in


def dialog(prompt, default="", hidden=False):
    """The text typed into a macOS dialog, or None when cancelled."""
    script = ['on run argv',
              'display dialog (item 1 of argv) default answer (item 2 of argv)%s with title "Bambu Lab" '
              'buttons {"Cancel", "OK"} default button "OK" with icon note' % (" with hidden answer" if hidden else ""),
              'return text returned of result', 'end run']
    args = ["osascript"]
    for line in script:
        args += ["-e", line]
    r = subprocess.run(args + [prompt, default], capture_output=True, text=True)
    return r.stdout.rstrip("\n") if r.returncode == 0 else None


def token_pair(answer, headers=None):
    """(access, refresh) from a login answer's body, or from its cookies (the web's two-factor sign-in)."""
    access = answer.get("accessToken") or answer.get("token") or ""
    refresh = answer.get("refreshToken") or ""
    if not access and headers is not None:
        jar = http.cookies.SimpleCookie()
        for header in headers.get_all("Set-Cookie") or []:
            try:
                jar.load(header)
            except http.cookies.CookieError:
                continue
        access = jar["token"].value if "token" in jar else ""
        refresh = jar["refreshToken"].value if "refreshToken" in jar else refresh
    return access, refresh


def sign_in():
    """Runs the sign-in dialogs; answers a toast."""
    saved.put(cloud=REGION)
    email = dialog("Your Bambu Lab account's email:", saved.get("email") or "")
    if not email:
        return "Sign-in cancelled"
    email = email.strip()
    saved.put(email=email)
    password = dialog("Password for %s. It goes to Bambu Lab only and is never stored.\n\n"
                      "Leave it empty to get a code by email instead." % email, hidden=True)
    if password is None:
        return "Sign-in cancelled"
    kind, answer, headers = "verifyCode", {}, None
    if password:
        status, answer, headers = cloud.call("POST", "/v1/user-service/user/login",
                                             {"account": email, "password": password, "apiError": ""}, signed=False)
        password = None
        kind = answer.get("loginType") or ""
        if status >= 400 and not kind:
            raise Problem(answer.get("error") or answer.get("message") or "Bambu Lab refused the sign-in")
    if kind == "verifyCode":
        cloud.call("POST", "/v1/user-service/user/sendemail/code", {"email": email, "type": "codeLogin"}, signed=False)
        code = dialog("Bambu Lab emailed a code to %s. Type it here:" % email)
        if not code:
            return "Sign-in cancelled"
        status, answer, headers = cloud.call("POST", "/v1/user-service/user/login",
                                             {"account": email, "code": code.strip()}, signed=False)
    elif kind == "tfa":
        code = dialog("The code from your authenticator app:")
        if not code:
            return "Sign-in cancelled"
        status, answer, headers = cloud.call("POST", "", {"tfaKey": answer.get("tfaKey"), "tfaCode": code.strip()},
                                             signed=False, url=cloud.urls["web"] + "/api/sign-in/tfa")
    access, refresh = token_pair(answer, headers)
    if not access:
        raise Problem(answer.get("error") or answer.get("message") or "Bambu Lab didn't sign you in")
    cloud.keep(access, refresh)
    saved.put(uid="", devices=[], tasks={})
    log("sign-in: done")
    session.wake()
    return "Signed in to Bambu Lab"


# ---------------------------------------------------------------- MQTT 3.1.1, QoS 0


def utf8(text):
    data = text.encode()
    return struct.pack("!H", len(data)) + data


def length_bytes(n):
    out = bytearray()
    while True:
        n, digit = divmod(n, 128)
        out.append(digit | (0x80 if n else 0))
        if not n:
            return bytes(out)


class Refused(Exception):
    """The broker refused the username or token."""


class Mqtt:
    def __init__(self, host, username, password):
        self.host, self.username, self.password = host, username, password
        self.sock = None
        self.sent_at = self.heard_at = time.monotonic()

    def open(self):
        raw = socket.create_connection((self.host, 8883), timeout=15)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=self.host)
        flags = 0x80 | 0x40 | 0x02  # username, password, clean session
        body = (utf8("MQTT") + bytes([4, flags]) + struct.pack("!H", KEEPALIVE)
                + utf8("claude-bambu-" + secrets.token_hex(4)) + utf8(self.username) + utf8(self.password))
        self.send(0x10, body)
        kind, _, reply = self.receive(wait=15)
        if kind != 2 or len(reply) < 2:
            raise OSError("the broker didn't acknowledge the connection")
        if reply[1] in (4, 5):
            raise Refused()
        if reply[1]:
            raise OSError("the broker refused the connection (%d)" % reply[1])

    def send(self, header, body):
        self.sock.sendall(bytes([header]) + length_bytes(len(body)) + body)
        self.sent_at = time.monotonic()

    def subscribe(self, topic):
        self.send(0x82, struct.pack("!H", 1) + utf8(topic) + b"\x00")

    def publish(self, topic, message):
        self.send(0x30, utf8(topic) + json.dumps(message).encode())

    def ping(self):
        self.send(0xC0, b"")

    def close(self):
        try:
            if self.sock:
                self.sock.close()
        except OSError:
            pass

    def read(self, n, deadline):
        data = b""
        while len(data) < n:
            try:
                chunk = self.sock.recv(n - len(data))
            except socket.timeout:
                if time.monotonic() > deadline:
                    raise OSError("the broker stalled mid-message")
                continue
            if not chunk:
                raise OSError("the broker closed the connection")
            data += chunk
        return data

    def receive(self, wait=1.0):
        """(type, flags, body) of the next packet, or (None, 0, b"") when nothing came within `wait` seconds."""
        self.sock.settimeout(wait)
        try:
            first = self.sock.recv(1)
        except socket.timeout:
            return None, 0, b""
        if not first:
            raise OSError("the broker closed the connection")
        deadline = time.monotonic() + 30
        self.sock.settimeout(5)
        size, shift = 0, 0
        while True:
            byte = self.read(1, deadline)[0]
            size |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
        body = self.read(size, deadline) if size else b""
        self.heard_at = time.monotonic()
        return first[0] >> 4, first[0] & 0x0F, body


def published(body, flags):
    """(topic, payload) of a PUBLISH body."""
    size = struct.unpack("!H", body[:2])[0]
    topic = body[2:2 + size].decode(errors="replace")
    start = 2 + size + (2 if flags & 0x06 else 0)
    return topic, body[start:]


# ---------------------------------------------------------------- one printer


def merge(into, part):
    """Folds a partial report into the full one: dicts key by key, lists of {"id": ...} entry by entry."""
    for key, value in part.items():
        old = into.get(key)
        if isinstance(value, dict) and isinstance(old, dict):
            merge(old, value)
        elif (isinstance(value, list) and isinstance(old, list) and value
              and all(isinstance(v, dict) and "id" in v for v in value)):
            by_id = {o.get("id"): o for o in old if isinstance(o, dict)}
            for v in value:
                if isinstance(by_id.get(v["id"]), dict):
                    merge(by_id[v["id"]], v)
                else:
                    old.append(v)
                    by_id[v["id"]] = v
        else:
            into[key] = value


def job_of(report):
    return report.get("gcode_state"), str(report.get("task_id") or ""), report.get("subtask_name")


class Printer:
    def __init__(self, device):
        self.serial = device["dev_id"]
        self.name = device.get("name") or ""
        self.online = device.get("online")
        self.lock = threading.Lock()
        self.report = {}
        self.report_at = 0.0
        self.remaining_at = 0.0
        self.finished_at = 0.0
        self.connected = False
        self.error = ""
        self.tasks = list((saved.get("tasks") or {}).get(self.serial) or [])
        self.tasks_at = 0.0
        self.mqtt = None
        self.stop = threading.Event()

    def start(self):
        background(self.follow_fixture if FIXTURE else self.follow)

    def halt(self):
        self.stop.set()
        if self.mqtt:
            self.mqtt.close()

    def follow(self):
        backoff = 2
        while not self.stop.is_set():
            client = None
            try:
                uid = account_uid()
                client = Mqtt(CLOUDS[saved.get("cloud") or REGION]["mqtt"], "u_" + uid, cloud.access)
                client.open()
                self.mqtt = client
                with self.lock:
                    self.connected, self.error = True, ""
                changed.set()
                log("mqtt: connected")
                backoff = 2
                self.listen(client)
            except Refused:
                log("mqtt: refused")
                if not cloud.renew(client.password if client else ""):
                    cloud.forget("Bambu Lab's broker refused the sign-in; sign in again")
                    return
                continue
            except Problem as e:
                with self.lock:
                    self.error = str(e)
                if not cloud.signed_in():
                    return
            except (OSError, ssl.SSLError, ValueError, struct.error) as e:
                log("mqtt:", e)
                with self.lock:
                    self.error = str(e) or type(e).__name__
            finally:
                self.mqtt = None
                if client:
                    client.close()
                with self.lock:
                    self.connected = False
                changed.set()
            self.stop.wait(backoff)
            backoff = min(backoff * 2, 120)

    def listen(self, client):
        client.subscribe("device/%s/report" % self.serial)
        self.ask_everything()
        asked = time.monotonic()
        while not self.stop.is_set():
            kind, flags, body = client.receive()
            if kind == 3:
                topic, payload = published(body, flags)
                if topic.endswith("/report"):
                    self.on_message(payload)
            elif kind == 9 and body[-1:] == b"\x80":
                raise Problem("Bambu Lab won't share this printer's reports with this account")
            now = time.monotonic()
            if now - client.sent_at > KEEPALIVE / 2:
                client.ping()
            if now - client.heard_at > KEEPALIVE * 1.5:
                raise OSError("the broker went quiet")
            if time.time() - self.report_at > QUIET_PUSHALL and now - asked > QUIET_PUSHALL:
                asked = now
                self.ask_everything()

    def follow_fixture(self):
        """Plays BAMBU_FIXTURE: each line a message, or {"msg": message}; ends connected.

        {"device": name} names the printer; {"tasks": [...]} stands in for its cloud tasks, each
        {"id", "title", "status", "ago": seconds since it ended, "cover": a PNG beside the fixture,
        and what fetch_details() would find: "settings", "bed", "objects"}."""
        with self.lock:
            self.connected = True
        here = os.path.dirname(os.path.abspath(FIXTURE))
        try:
            with open(FIXTURE) as f:
                for line in f:
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(entry, dict) and ("device" in entry or "tasks" in entry):
                        with self.lock:
                            self.name = str(entry.get("device") or self.name)
                            for t in entry.get("tasks") or []:
                                if not isinstance(t, dict):
                                    continue
                                task = task_of(t)
                                task["end"] = time.time() - t["ago"] if isinstance(t.get("ago"), (int, float)) else None
                                task["cover"] = os.path.join(here, t["cover"]) if t.get("cover") else ""
                                self.tasks.append(task)
                                details[task["id"]] = {k: t[k] for k in ("settings", "bed", "objects") if k in t}
                        continue
                    message = entry.get("msg", entry) if isinstance(entry, dict) else None
                    if isinstance(message, dict):
                        self.on_message(json.dumps(message).encode())
        except OSError as e:
            log("fixture:", e)
        changed.set()

    def send(self, message):
        if FIXTURE:
            return
        client = self.mqtt
        if not client:
            raise Problem("Not connected to the printer yet")
        try:
            client.publish("device/%s/request" % self.serial, message)
        except OSError as e:
            raise Problem("Couldn't reach Bambu Lab's broker") from e

    def ask_everything(self):
        self.send({"pushing": {"sequence_id": "0", "command": "pushall", "version": 1, "push_target": 1}})

    def on_message(self, payload):
        try:
            message = json.loads(payload)
        except ValueError:
            return
        if not isinstance(message, dict):
            return
        event = message.get("event")
        if isinstance(event, dict) and event.get("event") in ("client.connected", "client.disconnected"):
            with self.lock:
                self.online = event["event"] == "client.connected"
            changed.set()
            return
        part = message.get("print")
        if isinstance(part, dict) and part.get("command") == "push_status":
            self.on_report(part)
        changed.set()

    def on_report(self, part):
        with self.lock:
            before = job_of(self.report)
            remaining = self.report.get("mc_remaining_time")
            merge(self.report, part)
            now = time.time()
            self.report_at, self.online = now, True
            if "mc_remaining_time" in part and (part["mc_remaining_time"] != remaining or not self.remaining_at):
                self.remaining_at = now
            after = job_of(self.report)
            if before[0] in ACTIVE_STATES and after[0] in ("FINISH", "FAILED", "IDLE"):
                self.finished_at = now
        if (before != after or time.time() - self.tasks_at > TASKS_EVERY) and not FIXTURE:
            self.tasks_at = time.time()
            background(self.fetch_tasks, 3 if before != after and before[0] else 0)

    def fetch_tasks(self, delay=0):
        time.sleep(delay)
        try:
            answer = cloud.get("/v1/user-service/my/tasks?" + urllib.parse.urlencode({"deviceId": self.serial, "limit": 10}))
        except Problem as e:
            log("tasks:", e)
            return
        tasks = [task_of(t) for t in answer.get("hits") or [] if isinstance(t, dict)]
        with self.lock:
            self.tasks = tasks
        everything = dict(saved.get("tasks") or {})
        everything[self.serial] = [{k: v for k, v in t.items() if k not in SIGNED} for t in tasks[:5]]
        saved.put(tasks=everything)
        changed.set()

    def task(self):
        """The cloud task behind what the printer shows: matched by id, then by name; else the newest."""
        with self.lock:
            r, tasks = dict(self.report), list(self.tasks)
        if not tasks:
            return None
        task_id = str(r.get("task_id") or "")
        for t in tasks:
            if task_id not in ("", "0") and t["id"] == task_id:
                return t
        state = r.get("gcode_state") or ""
        if state in ACTIVE_STATES or state in ("FINISH", "FAILED"):
            name = simple_name(r.get("subtask_name"))
            return next((t for t in tasks[:3] if name and name in (simple_name(t["title"]), simple_name(t["design"]))), None)
        return tasks[0]


def task_of(t):
    def when(text):
        try:
            return calendar.timegm(time.strptime(text[:19], "%Y-%m-%dT%H:%M:%S")) if text else None
        except ValueError:
            return None
    configs = {c.get("name"): c.get("url") or "" for c in ((t.get("extention") or {}).get("modelInfo") or {}).get("configs") or []
               if isinstance(c, dict)}
    plate = "plate_%d.json" % int(number(t.get("plateIndex"), 1) or 1)
    return {"id": str(t.get("id") or ""), "title": t.get("title") or "", "design": t.get("designTitle") or "",
            "status": t.get("status"), "end": when(t.get("endTime")), "cover": t.get("cover") or "",
            "profile": t.get("instanceTitle") or "", "plate": configs.get(plate) or "",
            "settings": configs.get("project_settings.config") or ""}


# The task's links to its files: signed for half an hour, so kept in memory only.
SIGNED = ("cover", "plate", "settings")


def simple_name(text):
    return re.sub(r"[^a-z0-9]+", "", re.sub(r"\.(gcode|3mf)$", "", (text or "").lower()))


# ---------------------------------------------------------------- the account and its printers


def account_uid():
    uid = saved.get("uid")
    if not uid:
        uid = str(cloud.get("/v1/design-user-service/my/preference").get("uid") or "")
        if not uid:
            raise Problem("Bambu Lab didn't say which account this is")
        saved.put(uid=uid)
    return uid


class Session:
    """Keeps the bound-printer list fresh and follows the wanted printer."""

    def __init__(self):
        self.printer = None
        self.devices_at = 0.0
        self.error = ""
        self.poke = threading.Event()

    def wake(self):
        self.poke.set()

    def run(self):
        while not stopping.is_set():
            try:
                self.step()
            except Exception as e:  # the loop must outlive any one bad answer
                log("session:", repr(e))
            changed.set()
            self.poke.wait(60)
            self.poke.clear()

    def step(self):
        if FIXTURE:
            if not self.printer:
                self.printer = Printer({"dev_id": "FIXTURE", "name": "Fixture", "online": True})
                self.printer.start()
            return
        if not cloud.signed_in():
            cloud.access = keychain_get("access")  # signed in from another session meanwhile?
            cloud.refresh = keychain_get("refresh")
            if not cloud.signed_in():
                self.drop()
                return
        if not saved.get("devices") or time.time() - self.devices_at > DEVICES_EVERY:
            try:
                answer = cloud.get("/v1/iot-service/api/user/bind")
                devices = [{"dev_id": d.get("dev_id"), "name": d.get("name") or "", "online": d.get("online"),
                            "model": d.get("dev_product_name") or ""}
                           for d in answer.get("devices") or [] if isinstance(d, dict) and d.get("dev_id")]
                saved.put(devices=devices)
                self.devices_at, self.error = time.time(), ""
            except Problem as e:
                self.error = str(e)
                return
        device = self.device()
        if not device:
            self.drop()
            return
        if not self.printer or self.printer.serial != device["dev_id"]:
            self.drop()
            self.printer = Printer(device)
            self.printer.start()
        elif device.get("online") is not None and not self.printer.connected:
            self.printer.online = device["online"]

    def device(self):
        devices = saved.get("devices") or []
        if not WANTED_PRINTER:
            return devices[0] if devices else None
        for d in devices:
            serial = d["dev_id"].lower()
            if WANTED_PRINTER == d["name"].lower() or WANTED_PRINTER == serial or (
                    len(WANTED_PRINTER) >= 4 and serial.endswith(WANTED_PRINTER)):
                return d
        return None

    def drop(self):
        if self.printer:
            self.printer.halt()
            self.printer = None


session = Session()


# ---------------------------------------------------------------- HMS descriptions


class Hms:
    """Bambu's own wording for HMS and print error codes, one table per printer type (a serial's first
    three characters: newer printers' codes are only in their own), each fetched once a week."""

    def __init__(self):
        self.tables = {}  # type: {"at": epoch, "table": {ecode: text}}
        self.tried = {}   # type: when its last fetch started
        try:
            with open(HMS_FILE) as f:
                self.tables = json.load(f).get("tables") or {}
        except (OSError, ValueError, AttributeError):
            pass

    def table(self, kind):
        kept = self.tables.get(kind)
        if FIXTURE:
            return ((kept or next(iter(self.tables.values()), None)) or {}).get("table") or {}
        stale = not kept or time.time() - (kept.get("at") or 0) > 7 * 86400
        if stale and time.time() - self.tried.get(kind, 0) > 600:
            self.tried[kind] = time.time()
            background(self.fetch, kind)
        return (kept or {}).get("table") or {}

    def fetch(self, kind):
        try:
            url = HMS_URL + "&" + urllib.parse.urlencode({"d": kind})
            request = urllib.request.Request(url, headers={"User-Agent": HEADERS["User-Agent"]})
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read())
            table = {}
            for section in ("device_hms", "device_error"):
                for entry in ((data.get("data") or {}).get(section) or {}).get("en") or []:
                    if isinstance(entry, dict) and entry.get("ecode") and entry.get("intro"):
                        table[str(entry["ecode"]).upper()] = re.sub(r"\s+", " ", entry["intro"]).strip()
            if table:
                self.tables[kind] = {"at": time.time(), "table": table}
                with open(HMS_FILE, "w") as f:
                    json.dump({"tables": self.tables}, f)
            changed.set()
        except (OSError, ValueError, AttributeError) as e:
            log("hms:", e)

    def entries(self, r, kind):
        """Texts for the report's HMS entries and print error: (fatal and serious ones, worst first;
        the common and info notices Bambu's app shows in a banner, those with wording only)."""
        table = self.table(kind)
        found = []
        for entry in r.get("hms") or []:
            try:
                attr, code = int(entry.get("attr") or 0), int(entry.get("code") or 0)
            except (AttributeError, TypeError, ValueError):
                continue
            ecode = "%08X%08X" % (attr, code)
            found.append((code >> 16, table.get(ecode) or "HMS " + "_".join(ecode[i:i + 4] for i in range(0, 16, 4)), ecode in table))
        try:
            error = int(r.get("print_error") or 0)
        except (TypeError, ValueError):
            error = 0
        if error:
            ecode = "%08X" % error
            found.append((2, table.get(ecode) or "Print error %s_%s" % (ecode[:4], ecode[4:]), True))
        found.sort(key=lambda f: f[0])
        return [text for severity, text, _ in found if severity in (1, 2)], [text for severity, text, known in found if severity not in (1, 2) and known]


hms = None  # Hms, made in main()


# ---------------------------------------------------------------- plate thumbnails


def png_pixels(path):
    """(width, height, rows of RGBA bytes) of an 8-bit RGBA, non-interlaced PNG; None for anything else."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos, header, packed = 8, None, b""
    while pos + 8 <= len(data):
        size, kind = struct.unpack("!I4s", data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + size]
        if kind == b"IHDR":
            header = struct.unpack("!IIBBBBB", chunk)
        elif kind == b"IDAT":
            packed += chunk
        pos += 12 + size
    if not header or header[2:5] != (8, 6, 0) or header[6]:
        return None
    width, height = header[0], header[1]
    raw, stride, rows, above = zlib.decompress(packed), width * 4, [], bytearray(width * 4)
    for y in range(height):
        start = y * (stride + 1)
        kind, line = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        for i in range(stride):
            left = line[i - 4] if i >= 4 else 0
            up, corner = above[i], above[i - 4] if i >= 4 else 0
            if kind == 1:
                line[i] = (line[i] + left) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + up) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif kind == 4:
                guess = left + up - corner
                pa, pb, pc = abs(guess - left), abs(guess - up), abs(guess - corner)
                line[i] = (line[i] + (left if pa <= pb and pa <= pc else up if pb <= pc else corner)) & 0xFF
        rows.append(line)
        above = line
    return width, height, rows


def crop_square(path):
    """Crops a cover to a square around what's drawn on it: Bambu draws the parts small on an empty plate."""
    try:
        picture = png_pixels(path)
    except (OSError, zlib.error, struct.error) as e:
        log("cover:", e)
        return
    if not picture:
        return
    width, height, rows = picture
    xs, ys = [], []
    for y, line in enumerate(rows):
        opaque = [x for x in range(width) if line[x * 4 + 3] > 24]
        if opaque:
            xs += (opaque[0], opaque[-1])
            ys.append(y)
    if not xs:
        return
    side = min(width, height, int(max(max(xs) - min(xs), ys[-1] - ys[0]) * 1.15) + 8)
    if side >= min(width, height) * 0.9:
        return
    x0 = max(0, min(width - side, (min(xs) + max(xs) - side) // 2))
    y0 = max(0, min(height - side, (ys[0] + ys[-1] - side) // 2))
    subprocess.run(["sips", "-c", str(side), str(side), "--cropOffset", str(y0), str(x0), path],
                   capture_output=True, timeout=20)


fetching_covers = set()


def cover_for(task):
    """The path of the task's thumbnail when it's on disk; else starts fetching it and answers ""."""
    if not task or not task.get("id"):
        return ""
    if FIXTURE:
        return task["cover"] if os.path.isfile(task.get("cover") or "") else ""
    path =os.path.join(COVERS, hashlib.sha1(task["id"].encode()).hexdigest()[:16] + ".png")
    if os.path.exists(path):
        return path
    if task.get("cover") and task["id"] not in fetching_covers:
        fetching_covers.add(task["id"])
        background(fetch_cover, task["cover"], path)
    return ""


def fetch_cover(url, path):
    part = path + ".part"
    try:
        if not url.startswith("https://"):
            raise OSError("not an https URL")
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "claude-bambu"}), timeout=20) as r:
            data = r.read(8 * 1024 * 1024)
        with open(part, "wb") as f:
            f.write(data)
        r = subprocess.run(["sips", "-s", "format", "png", "-Z", "320", part, "--out", part + ".png"],
                           capture_output=True, timeout=20)
        if r.returncode != 0:
            raise OSError("sips couldn't read the cover")
        crop_square(part + ".png")
        os.replace(part + ".png", path)
        prune_covers()
    except (OSError, subprocess.SubprocessError) as e:
        log("cover:", e)
    finally:
        for leftover in (part, part + ".png"):
            if os.path.exists(leftover):
                os.remove(leftover)
    changed.set()


def prune_covers(keep=40):
    try:
        names = sorted((os.path.join(COVERS, n) for n in os.listdir(COVERS)), key=os.path.getmtime)
    except OSError:
        return
    for old in names[:-keep]:
        os.remove(old)


# ---------------------------------------------------------------- what the slicer wrote


details = {}           # task id: {"settings": "0.2mm layer, 2 walls, 15% infill", "bed": [x0, y0, x1, y1], "objects": [...]}
fetching_details = {}  # task id: when its fetch started
BED = [0, 0, 256, 256]


def details_for(task):
    """The task's print settings and plate objects once fetched; else starts fetching them and answers {}."""
    if not task or not task.get("id"):
        return {}
    if task["id"] in details or FIXTURE:
        return details.get(task["id"]) or {}
    # A failed fetch waits for the next task list, whose links are fresh.
    if (task.get("plate") or task.get("settings")) and time.time() - fetching_details.get(task["id"], 0) > TASKS_EVERY:
        fetching_details[task["id"]] = time.time()
        background(fetch_details, task)
    return {}


def fetch_json(url):
    if not url.startswith("https://"):
        raise OSError("not an https URL")
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "claude-bambu"}), timeout=20) as r:
        answer = json.loads(r.read(4 * 1024 * 1024))
    if not isinstance(answer, dict):
        raise ValueError("not a JSON object")
    return answer


def fetch_details(task):
    found = {}
    try:
        if task.get("settings"):
            found.update(slicer_settings(fetch_json(task["settings"])))
        if task.get("plate"):
            found["objects"] = plate_objects(fetch_json(task["plate"]))
    except (OSError, ValueError) as e:
        log("details:", e)
        return
    details[task["id"]] = found
    changed.set()


def first(value):
    return value[0] if isinstance(value, list) and value else value


def slicer_settings(settings):
    """The line Bambu's app shows under a print's name, and the bed's corners, from project_settings.config."""
    found, parts = {}, []
    layer, walls, infill = number(first(settings.get("layer_height"))), number(first(settings.get("wall_loops"))), first(settings.get("sparse_infill_density"))
    if layer:
        parts.append("%gmm layer" % layer)
    if walls is not None:
        parts.append("%d wall%s" % (walls, "" if walls == 1 else "s"))
    if isinstance(infill, str) and infill.strip():
        parts.append(infill.strip() + " infill")
    if parts:
        found["settings"] = ", ".join(parts)
    corners = [[number(v) for v in str(point).split("x")] for point in settings.get("printable_area") or []]
    if len(corners) >= 3 and all(len(c) == 2 and None not in c for c in corners):
        xs, ys = [c[0] for c in corners], [c[1] for c in corners]
        found["bed"] = [min(xs), min(ys), max(xs), max(ys)]
    return found


def plate_objects(plate):
    """The objects plate_N.json lists: the ids skip_objects takes, names without the file type, and bed boxes."""
    objects = []
    for o in plate.get("bbox_objects") or []:
        if not isinstance(o, dict) or not isinstance(o.get("id"), int) or not isinstance(o.get("bbox"), list) or len(o["bbox"]) < 4:
            continue
        name = re.sub(r"\.(stl|step|stp|obj|3mf)$", "", str(o.get("name") or ""), flags=re.I)
        objects.append({"id": o["id"], "name": name or "Object", "box": [round(number(v, 0), 1) for v in o["bbox"][:4]]})
    return objects


# ---------------------------------------------------------------- the view


def number(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def packed_temperature(value):
    """Newer firmware sends target << 16 | current."""
    value = int(number(value, -1))
    return (None, None) if value < 0 else (value & 0xFFFF, value >> 16)


def temperatures(r):
    device = r.get("device") if isinstance(r.get("device"), dict) else {}
    out = []
    nozzle = (None, None)
    for extruder in (device.get("extruder") or {}).get("info") or []:
        if isinstance(extruder, dict) and str(extruder.get("id")) == "0":
            nozzle = packed_temperature(extruder.get("temp"))
    if nozzle[0] is None:
        nozzle = (number(r.get("nozzle_temper")), number(r.get("nozzle_target_temper")))
    bed = packed_temperature(((device.get("bed") or {}).get("info") or {}).get("temp"))
    if bed[0] is None:
        bed = (number(r.get("bed_temper")), number(r.get("bed_target_temper")))
    chamber = packed_temperature(((device.get("ctc") or {}).get("info") or {}).get("temp"))
    if chamber[0] is None:
        chamber = (number(r.get("chamber_temper")), None)
    for label, (current, target) in (("Nozzle", nozzle), ("Bed", bed), ("Chamber", chamber)):
        if current is None or (label == "Chamber" and current <= 0):
            continue
        out.append({"label": label, "current": round(current), "target": round(target or 0),
                    "heating": bool(target and abs(current - target) > 10)})
    return out


def hex_color(tray):
    color = ((tray.get("cols") or [None])[0] or tray.get("tray_color") or "").strip()
    return "#" + color[:6].upper() if re.fullmatch(r"[0-9A-Fa-f]{6,8}", color) else ""


def ams_units(r):
    ams = r.get("ams") if isinstance(r.get("ams"), dict) else {}
    current = int(number(ams.get("tray_now"), 255))
    units = [u for u in ams.get("ams") or [] if isinstance(u, dict)]
    out = []
    for unit in units:
        uid = int(number(unit.get("id"), -1))
        if uid < 0:
            continue
        letter = "ABCDEFGH"[uid % 8]
        slots = []
        for tray in sorted((t for t in unit.get("tray") or [] if isinstance(t, dict)), key=lambda t: int(number(t.get("id"), 0))):
            index = uid * 4 + int(number(tray.get("id"), 0)) if uid < 128 else uid
            kind = tray.get("tray_type") or ""
            remain = tray.get("remain")
            slots.append({"type": kind, "color": hex_color(tray) if kind else "", "empty": not kind,
                          "remain": remain if isinstance(remain, int) and kind else -1, "active": index == current,
                          "name": "HT" if uid >= 128 else letter + str(int(number(tray.get("id"), 0)) + 1)})
        label = "HT" if uid >= 128 else "AMS" + (" " + letter if len(units) > 1 else "")
        humidity = number(unit.get("humidity_raw"))
        out.append({"label": label, "slots": slots, **({"humidity": round(humidity)} if humidity is not None and 0 < humidity <= 100 else {})})
    spools = r.get("vir_slot") or ([r["vt_tray"]] if isinstance(r.get("vt_tray"), dict) else [])
    for tray in spools:
        if isinstance(tray, dict) and tray.get("tray_type"):
            out.append({"label": "Ext", "slots": [{"type": tray["tray_type"], "color": hex_color(tray), "empty": False, "name": "Ext",
                                                   "remain": -1, "active": current in (254, int(number(tray.get("id"), -1)))}]})
    return out


def stage_of(r):
    """(label, tone) for the printer's state."""
    state = (r.get("gcode_state") or "").upper()
    named = STAGES.get(int(number(r.get("stg_cur"), -1)))
    if state == "RUNNING":
        return named or "Printing", "ok"
    if state == "PREPARE":
        return named or "Preparing", "info"
    if state in ("SLICING", "INIT"):
        return ("Slicing" if state == "SLICING" else "Starting"), "info"
    if state == "PAUSE":
        return (named if named and named.startswith("Paused") else "Paused"), "warn"
    if state == "FINISH":
        return "Finished", "ok"
    if state == "FAILED":
        return "Failed", "bad"
    return "Idle", "dim"


def light_on(r):
    for light in r.get("lights_report") or []:
        if isinstance(light, dict) and light.get("node") == "chamber_light":
            return light.get("mode") == "on"
    return None


def duration(minutes):
    minutes = max(0, int(round(minutes)))
    if minutes >= 1440:
        return "%dd %dh" % (minutes // 1440, minutes // 60 % 24)
    return "%dh %02dm" % (minutes // 60, minutes % 60) if minutes >= 60 else "%dm" % minutes


def ago(seconds):
    seconds = max(0, int(seconds))
    if seconds < 90:
        return "just now"
    if seconds < 3600:
        return "%dm ago" % (seconds // 60)
    return "%dh ago" % (seconds // 3600) if seconds < 2 * 86400 else "%dd ago" % (seconds // 86400)


def at_clock(epoch):
    at, today = time.localtime(epoch), time.localtime()
    if (at.tm_year, at.tm_yday) == (today.tm_year, today.tm_yday):
        return time.strftime("%H:%M", at)
    tomorrow = time.localtime(time.time() + 86400)
    if (at.tm_year, at.tm_yday) == (tomorrow.tm_year, tomorrow.tm_yday):
        return time.strftime("tomorrow %H:%M", at)
    return time.strftime("%a %H:%M", at)


def build_view():
    if not FIXTURE and not cloud.signed_in():
        return {"kind": "signed-out", "message": cloud.signed_out or "Sign in to Bambu Lab to follow your printer"}
    if not FIXTURE and (saved.get("cloud") or REGION) != REGION:
        return {"kind": "signed-out", "message": "The region changed; sign in again"}
    printer = session.printer
    if not printer:
        if session.error:
            return {"kind": "looking", "message": session.error}
        if session.devices_at and not saved.get("devices"):
            return {"kind": "looking", "message": "No printers are bound to this Bambu Lab account"}
        if session.devices_at and WANTED_PRINTER:
            return {"kind": "looking", "message": "No printer named \"%s\" on this account" % WANTED_PRINTER}
        return {"kind": "looking", "message": "Looking for your printers…"}
    with printer.lock:
        r = json.loads(json.dumps(printer.report))
        connected, error, online = printer.connected, printer.error, printer.online
        remaining_at, finished_at = printer.remaining_at, printer.finished_at
    state = (r.get("gcode_state") or "").upper()
    kind = "offline" if online is False else "waiting" if not r else "active" if state in ACTIVE_STATES else "idle"
    label, tone = stage_of(r)
    task = printer.task()
    view = {"kind": kind, "device": printer.name, "connected": connected, "error": error, "light": light_on(r),
            "thumb": cover_for(task), "stage": {"label": label, "tone": tone}}
    view["hms"], view["notices"] = (texts[:2] for texts in hms.entries(r, printer.serial[:3]))
    if kind == "waiting":
        view["message"] = "Waiting for the printer…" if connected else "Reconnecting…" if error else "Connecting…"
    if kind == "active":
        found = details_for(task)
        skipped = {int(number(i, -1)) for i in r.get("s_obj") or []}
        objects = [dict(o, skipped=o["id"] in skipped) for o in found.get("objects") or []]
        view.update(settings=found.get("settings") or (task or {}).get("profile") or "", objects=objects,
                    bed=found.get("bed") or BED)
        view.update(name=(task or {}).get("design") or r.get("subtask_name") or os.path.basename(r.get("gcode_file") or "") or "Print",
                    percent=int(number(r.get("mc_percent"), 0)), layer=int(number(r.get("layer_num"), 0)),
                    layers=int(number(r.get("total_layer_num"), 0)), speed=SPEEDS.get(int(number(r.get("spd_lvl"), 2)), ""),
                    paused=state == "PAUSE", temps=temperatures(r), ams=ams_units(r))
        remaining = number(r.get("mc_remaining_time"))
        if remaining and state in ("RUNNING", "PREPARE"):
            finish = (remaining_at or time.time()) + remaining * 60
            view["left"] = duration((finish - time.time()) / 60) + " left"
            view["done"] = "done " + at_clock(finish)
        elif remaining and state == "PAUSE":
            view["left"] = duration(remaining) + " left when resumed"
        return view
    if state in ("FINISH", "FAILED") and r.get("subtask_name"):
        end = (task or {}).get("end") or finished_at or None
        failed = state == "FAILED"
        view["last"] = {"name": (task or {}).get("design") or r["subtask_name"], "verb": "Failed" if failed else "Finished", "tone": "bad" if failed else "ok",
                        "when": ago(time.time() - end) if end else ""}
    elif task:
        status = task.get("status")
        verb, last_tone = ("Finished", "ok") if status == 2 else ("Stopped", "bad") if status == 3 else ("Printed", "dim")
        view["last"] = {"name": task["design"] or task["title"] or "Untitled", "verb": verb, "tone": last_tone,
                        "when": ago(time.time() - task["end"]) if task.get("end") else ""}
    if kind == "idle":
        view["temps"] = [t for t in temperatures(r) if t["label"] != "Chamber" and (t["target"] or t["current"] >= 40)]
        view["ams"] = ams_units(r)
    return view


# ---------------------------------------------------------------- commands and output


def run_command(cmd, entry=None):
    try:
        if cmd == "sign-in":
            emit({"toast": sign_in()})
        elif cmd == "sign-out":
            cloud.forget()
            saved.put(uid="", devices=[], tasks={})
            session.wake()
            emit({"toast": "Signed out of Bambu Lab"})
        elif cmd == "refresh":
            session.devices_at = 0
            session.wake()
            if session.printer and session.printer.connected:
                session.printer.ask_everything()
            emit({"toast": "Asked for a fresh status"})
        else:
            printer = session.printer
            if not printer:
                raise Problem("No printer yet")
            if cmd == "light":
                with printer.lock:
                    mode = "off" if light_on(printer.report) else "on"
                printer.send({"system": {"sequence_id": "0", "command": "ledctrl", "led_node": "chamber_light",
                                         "led_mode": mode, "led_on_time": 500, "led_off_time": 500,
                                         "loop_times": 0, "interval_time": 0}})
                emit({"toast": "Light " + mode})
            elif cmd == "skip":
                emit({"toast": skip_objects(printer, (entry or {}).get("objects"))})
            elif cmd in ("pause", "resume", "stop"):
                printer.send({"print": {"sequence_id": "0", "command": cmd, "param": ""}})
                emit({"toast": {"pause": "Pausing the print", "resume": "Resuming the print", "stop": "Stopping the print"}[cmd]})
    except Problem as e:
        emit({"error": str(e)})
    except Exception as e:
        log("command %s: %r" % (cmd, e))
        emit({"error": "Something went wrong; see bridge.log"})
    changed.set()


def skip_objects(printer, wanted):
    with printer.lock:
        r = dict(printer.report)
    if (r.get("gcode_state") or "").upper() not in ACTIVE_STATES:
        raise Problem("No print to skip objects in")
    skipped = {int(number(i, -1)) for i in r.get("s_obj") or []}
    left = [o["id"] for o in details_for(printer.task()).get("objects") or [] if o["id"] not in skipped]
    ids = sorted({i for i in wanted or [] if isinstance(i, int) and i in left})
    if not ids:
        raise Problem("Nothing to skip")
    if len(ids) >= len(left):
        raise Problem("That's every object left; stop the print instead")
    printer.send({"print": {"sequence_id": "0", "command": "skip_objects", "obj_list": ids}})
    if FIXTURE:  # no printer to answer with s_obj
        with printer.lock:
            printer.report["s_obj"] = sorted(skipped | set(ids))
    return "Skipping %d object%s" % (len(ids), "" if len(ids) == 1 else "s")


def watch_commands():
    busy = set()

    def run(cmd, entry):
        try:
            run_command(cmd, entry)
        finally:
            busy.discard(cmd)

    while not stopping.wait(0.4):
        try:
            names = sorted(n for n in os.listdir(COMMANDS) if n.endswith(".json"))
        except OSError:
            continue
        for name in names:
            path = os.path.join(COMMANDS, name)
            try:
                with open(path) as f:
                    entry = json.load(f) or {}
                cmd = entry.get("cmd")
            except (OSError, ValueError, AttributeError):
                entry, cmd = None, None
            try:
                os.remove(path)
            except OSError:
                pass
            if cmd in ("sign-in", "sign-out", "refresh", "light", "pause", "resume", "stop", "skip") and cmd not in busy:
                busy.add(cmd)
                background(run, cmd, entry)


def push_views():
    """A view on every change, at most once a second, and every 30 seconds for the clocks."""
    last = 0.0
    while not stopping.is_set():
        changed.wait(30)
        pause = 1.0 - (time.monotonic() - last)
        if pause > 0:
            time.sleep(pause)
        changed.clear()
        try:
            emit({"view": build_view(), "commands": COMMANDS})
        except Exception as e:
            log("view:", repr(e))
        last = time.monotonic()


def main():
    global saved, cloud, hms
    for folder in (ROOT, COMMANDS, COVERS):
        os.makedirs(folder, exist_ok=True)
    saved = Saved()
    cloud = Cloud()
    hms = Hms()
    log("start", "fixture" if FIXTURE else REGION)
    background(session.run)
    background(watch_commands)
    changed.set()
    try:
        push_views()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
