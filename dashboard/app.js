import mqtt from "https://cdn.jsdelivr.net/npm/mqtt@5.16.0/dist/mqtt.esm.js";
import { drawHistory, drawSpark } from "./chart.js";
import { Simulator } from "./sim.js";

const BROKER = "wss://broker.emqx.io:8084/mqtt";
const params = new URLSearchParams(location.search);
const REAL_DEVICE = (params.get("device") || "demo-01").replace(/[^\w-]/g, "").slice(0, 32) || "demo-01";
const STALE_MS = 20000;   // no state for this long while "online" = treat as offline
const HISTORY_MS = 60 * 60000;

const $ = (id) => document.getElementById(id);
const css = getComputedStyle(document.documentElement);
const color = (name) => css.getPropertyValue(name).trim();

const state = {
  device: REAL_DEVICE,
  base: "",
  status: null,        // "online" | "offline" | null (unknown)
  last: null,          // last state message
  lastAt: 0,           // when it arrived (ms)
  config: { mode: "auto", soilMin: 35, tempMax: 32 },
  points: [],          // [{ts, t, h, soil, light, pump}] for the chart
  spark: { t: [], h: [], soil: [], light: [] },
  log: [],
  sim: null,
  cfgDirty: false,
};

// ---------- MQTT ----------

const client = mqtt.connect(BROKER, {
  clientId: "smartfarm-dash-" + Math.random().toString(16).slice(2, 10),
  clean: true,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
});
client.on("connect", () => {
  addLog("เชื่อมต่อ MQTT broker แล้ว");
  // mqtt.js resubscribes by itself after a reconnect; only the first connect sets up.
  if (!state.base) watch(state.device);
});
client.on("reconnect", () => setPill("connecting"));
client.on("error", (err) => console.warn("SmartFarm: mqtt error", err.message));
client.on("message", (topic, payload) => {
  if (!topic.startsWith(state.base + "/")) return;
  const sub = topic.slice(state.base.length + 1);
  const text = payload.toString();
  try {
    if (sub === "status") onStatus(text);
    else if (sub === "state") onState(JSON.parse(text));
    else if (sub === "config") onConfig(JSON.parse(text));
    else if (sub === "history") onHistory(JSON.parse(text));
  } catch (err) {
    console.warn("SmartFarm: bad message on", topic, err);
  }
});

function watch(device) {
  if (state.base) client.unsubscribe(`${state.base}/#`);
  state.device = device;
  state.base = `smartfarm-th/${device}`;
  state.status = null;
  state.last = null;
  state.lastAt = 0;
  state.points = [];
  state.spark = { t: [], h: [], soil: [], light: [] };
  state.cfgDirty = false;
  $("deviceId").textContent = device;
  $("m-topic").textContent = `${state.base}/#`;
  client.subscribe(`${state.base}/#`, { qos: 1 });
  render();
  // Retained messages arrive at once; if nothing says "online", show the offline banner.
  setTimeout(() => { if (state.status === null) { state.status = "offline"; render(); } }, 4000);
}

function send(cmd) {
  client.publish(`${state.base}/cmd`, JSON.stringify(cmd), { qos: 1 });
}

// ---------- incoming ----------

function onStatus(text) {
  if (text !== state.status) {
    if (state.status !== null) addLog(text === "online" ? "บอร์ดออนไลน์" : "บอร์ดออฟไลน์");
    state.status = text;
  }
  render();
}

function onState(s) {
  const prev = state.last;
  state.last = s;
  state.lastAt = Date.now();
  if (prev) {
    if (prev.pump !== s.pump) addLog(s.pump ? `ปั๊มน้ำเปิด (ดิน ${s.soil}%)` : s.pumpResting ? "ปั๊มพัก 30 วินาที (ทำงานครบ 1 นาที)" : `ปั๊มน้ำปิด (ดิน ${s.soil}%)`);
    if (prev.fan !== s.fan) addLog(s.fan ? `พัดลมเปิด (${s.t}°C)` : `พัดลมปิด (${s.t}°C)`);
    if (prev.mode !== s.mode) addLog(s.mode === "auto" ? "เปลี่ยนเป็นโหมดอัตโนมัติ" : "เปลี่ยนเป็นโหมดสั่งเอง");
  }
  for (const k of ["t", "h", "soil", "light"]) {
    if (s[k] == null) continue;
    state.spark[k].push(s[k]);
    if (state.spark[k].length > 60) state.spark[k].shift();
  }
  const ts = s.ts ? s.ts * 1000 : Date.now();
  const lastPoint = state.points[state.points.length - 1];
  if (!lastPoint || ts - lastPoint.ts >= 5000) {
    state.points.push({ ts, t: s.t, h: s.h, soil: s.soil, light: s.light, pump: s.pump ? 100 : 0 });
    trimPoints();
  }
  if (state.status !== "online" && s.ts && Date.now() - ts < STALE_MS) state.status = "online";
  render();
}

function onConfig(c) {
  state.config = { ...state.config, ...c };
  if (!state.cfgDirty) {
    $("soilMin").value = state.config.soilMin;
    $("tempMax").value = state.config.tempMax;
  }
  render();
}

function onHistory(rows) {
  if (!Array.isArray(rows)) return;
  const pts = rows.filter((r) => Array.isArray(r) && r[0] > 1e9).map((r) => ({ ts: r[0] * 1000, t: r[1], h: r[2], soil: r[3], light: r[4], pump: r[5] }));
  const newest = pts.length ? pts[pts.length - 1].ts : 0;
  state.points = [...pts, ...state.points.filter((p) => p.ts > newest)];
  trimPoints();
  render();
}

function trimPoints() {
  const end = state.points.length ? state.points[state.points.length - 1].ts : Date.now();
  state.points = state.points.filter((p) => p.ts >= end - HISTORY_MS).sort((a, b) => a.ts - b.ts);
}

// ---------- rendering ----------

function setPill(kind) {
  const pill = $("status");
  pill.className = "pill " + kind;
  pill.querySelector("b").textContent = {
    online: "ออนไลน์", offline: "ออฟไลน์", sim: "อุปกรณ์จำลอง", connecting: "กำลังเชื่อมต่อ…",
  }[kind];
}

// When the data was measured: the board's NTP timestamp if it sent one,
// otherwise when the message arrived (retained messages arrive at once, so
// that alone would make old data look fresh).
function dataTime() {
  return state.last?.ts ? state.last.ts * 1000 : state.lastAt;
}

function isLive() {
  return state.status === "online" && Date.now() - dataTime() < STALE_MS;
}

function render() {
  const s = state.last;
  const live = isLive();
  setPill(state.sim ? "sim" : state.status === null ? "connecting" : live ? "online" : "offline");
  $("offline").hidden = !!state.sim || state.status === null || live;
  $("simBanner").hidden = !state.sim;
  if (!live && !state.sim) {
    $("offlineTitle").textContent = `บอร์ด ${state.device} ออฟไลน์อยู่`;
    $("offlineText").textContent = s?.ts
      ? `ข้อมูลที่เห็นคือค่าล่าสุดที่บอร์ดส่งไว้เมื่อ ${new Date(s.ts * 1000).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })} บอร์ดจริงรันบน Wokwi (ตัวจำลอง ESP32) เป็นช่วง ๆ`
      : "ยังไม่มีข้อมูลจากบอร์ด บอร์ดจริงรันบน Wokwi (ตัวจำลอง ESP32) เป็นช่วง ๆ ลองเปิดอุปกรณ์จำลองในเบราว์เซอร์แทนได้";
  }

  const fmt = (v, d = 0) => (v == null ? "–" : Number(v).toFixed(d));
  $("v-t").textContent = s?.sensorOk === false ? "ERR" : fmt(s?.t, 1);
  $("v-h").textContent = fmt(s?.h);
  $("v-soil").textContent = fmt(s?.soil);
  $("v-light").textContent = fmt(s?.light);
  const cfg = state.config;
  $("n-t").textContent = `พัดลมเปิดเมื่อเกิน ${cfg.tempMax}°C`;
  $("n-soil").textContent = `รดน้ำเมื่อต่ำกว่า ${cfg.soilMin}%`;
  document.querySelector('.card[data-key="t"]').classList.toggle("alert", s?.t > cfg.tempMax);
  document.querySelector('.card[data-key="soil"]').classList.toggle("alert", s?.soil < cfg.soilMin);
  drawSpark($("s-t"), state.spark.t, color("--temp"));
  drawSpark($("s-h"), state.spark.h, color("--muted"));
  drawSpark($("s-soil"), state.spark.soil, color("--soil"));
  drawSpark($("s-light"), state.spark.light, color("--amber"));

  const manual = (s?.mode || cfg.mode) === "manual";
  const canControl = live || !!state.sim;
  document.querySelector(".control").classList.toggle("disabled", !canControl);
  document.querySelectorAll(".seg button").forEach((b) => {
    b.classList.toggle("on", b.dataset.mode === (manual ? "manual" : "auto"));
    b.disabled = !canControl;
  });
  for (const key of ["pump", "fan"]) {
    const btn = $(key);
    const on = !!s?.[key];
    btn.classList.toggle("on", on);
    btn.classList.toggle("resting", key === "pump" && !!s?.pumpResting);
    btn.disabled = !canControl || !manual;
    btn.title = manual ? "" : "สลับเป็นโหมดสั่งเองก่อน";
  }
  $("pumpState").textContent = s ? (s.pump ? "กำลังรดน้ำ" : s.pumpResting ? "พักปั๊ม (กันปั๊มทำงานนานเกิน)" : "ปิด") : "–";
  $("fanState").textContent = s ? (s.fan ? "กำลังระบายอากาศ" : "ปิด") : "–";
  $("modeHint").textContent = manual
    ? "โหมดสั่งเอง: กดเปิด/ปิดได้เลย (ปั๊มยังหยุดเองเมื่อทำงานครบ 1 นาที)"
    : "โหมดอัตโนมัติ: บอร์ดตัดสินใจเองจากค่าเซนเซอร์และค่าเกณฑ์";
  $("soilMinOut").textContent = $("soilMin").value;
  $("tempMaxOut").textContent = $("tempMax").value;
  $("saveCfg").disabled = !canControl || !state.cfgDirty;

  $("m-rssi").textContent = s?.rssi != null ? `${s.rssi} dBm` : "–";
  $("m-uptime").textContent = s?.uptime != null ? formatUptime(s.uptime) : "–";
  $("m-fw").textContent = s?.fw ? (s.fw === "sim" ? "จำลองในเบราว์เซอร์" : `v${s.fw}`) : "–";

  $("log").innerHTML = state.log.length
    ? state.log.slice(0, 8).map((l) => `<li><time>${l.time}</time><span>${l.text}</span></li>`).join("")
    : '<li class="empty">ยังไม่มีเหตุการณ์</li>';

  drawHistory($("chart"), state.points, {
    tempMax: Number(cfg.tempMax), soilMin: Number(cfg.soilMin),
    colors: { t: color("--temp"), soil: color("--soil"), pump: color("--green"), grid: color("--line"), text: color("--muted") },
  });
  renderAgo();
}

function renderAgo() {
  const sec = Math.round((Date.now() - dataTime()) / 1000);
  $("ago").textContent = state.lastAt && sec >= 0 && sec < 60 ? `อัปเดต ${sec} วินาทีที่แล้ว` : "";
}

function formatUptime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h} ชม. ${m} นาที` : m ? `${m} นาที ${sec % 60} วินาที` : `${sec} วินาที`;
}

function addLog(text) {
  state.log.unshift({ time: new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }), text });
  state.log.length = Math.min(state.log.length, 30);
}

// ---------- controls ----------

document.querySelector(".seg").addEventListener("click", (e) => {
  const mode = e.target.closest("button")?.dataset.mode;
  if (!mode) return;
  send({ mode });
  addLog(mode === "auto" ? "ส่งคำสั่ง: โหมดอัตโนมัติ" : "ส่งคำสั่ง: โหมดสั่งเอง");
  render();
});
for (const key of ["pump", "fan"]) {
  $(key).addEventListener("click", () => {
    const next = !state.last?.[key];
    send({ [key]: next });
    addLog(`ส่งคำสั่ง: ${key === "pump" ? "ปั๊มน้ำ" : "พัดลม"} ${next ? "เปิด" : "ปิด"}`);
    render();
  });
}
for (const id of ["soilMin", "tempMax"]) {
  $(id).addEventListener("input", () => { state.cfgDirty = true; render(); });
}
$("saveCfg").addEventListener("click", () => {
  const cmd = { soilMin: Number($("soilMin").value), tempMax: Number($("tempMax").value) };
  send(cmd);
  state.cfgDirty = false;
  addLog(`ส่งคำสั่ง: รดน้ำ < ${cmd.soilMin}% · พัดลม > ${cmd.tempMax}°C`);
  render();
});
$("startSim").addEventListener("click", () => {
  const id = "sim-" + Math.random().toString(36).slice(2, 6);
  watch(id);
  state.sim = new Simulator(client, `smartfarm-th/${id}`);
  state.sim.start();
  addLog("เปิดอุปกรณ์จำลองในเบราว์เซอร์");
  render();
});
$("stopSim").addEventListener("click", stopSim);
window.addEventListener("pagehide", () => state.sim?.stop());

function stopSim() {
  state.sim?.stop();
  state.sim = null;
  watch(REAL_DEVICE);
  addLog("กลับไปดูบอร์ดจริง");
}

setInterval(() => { renderAgo(); if (!isLive() && state.status === "online" && !state.sim) render(); }, 1000);
new ResizeObserver(() => render()).observe($("chart"));
if (params.has("debug")) window.smartfarm = { state, client };
if (params.get("sim") === "1") client.once("connect", () => $("startSim").click());
