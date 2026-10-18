// In-browser stand-in for the ESP32, for when the real board is offline. It runs
// the same control logic (control.js) on a toy greenhouse model and speaks the
// same topics and messages, on an in-page bus (localbus.js) instead of the broker.
import { Controller, settingsValid } from "./control.js";

const DAY_MS = 60 * 60 * 1000;   // a simulated day passes in one real hour
const TICK_MS = 1000;
const PUBLISH_MS = 2000;

export class Simulator {
  constructor(client, base) {
    this.client = client;
    this.base = base;
    this.ctl = new Controller();
    this.settings = { soilMin: 35, tempMax: 32, autoMode: true };
    this.env = { temp: 29, hum: 64, soil: 41, light: 60 };
    this.out = { pump: false, fan: false, pumpResting: false };
    this.clock = 0.12 * DAY_MS;  // simulated ms; start mid-morning, when the air is warming up
    this.bootClock = this.clock;
    this.history = [];
    this.timers = [];
    this.onCmd = (topic, payload) => {
      if (topic === `${this.base}/cmd`) this.command(JSON.parse(payload.toString()));
    };
  }

  start() {
    this.client.subscribe(`${this.base}/cmd`);
    this.client.on("message", this.onCmd);
    // Fast-forward one simulated hour so the chart has history straight away.
    const startReal = Date.now() - 60 * 60000;
    for (let m = 0; m < 60; m++) {
      let acc = { t: 0, h: 0, soil: 0, light: 0, pump: 0 };
      for (let s = 0; s < 60; s++) {
        this.step(1000);
        acc.t += this.env.temp; acc.h += this.env.hum; acc.soil += this.env.soil; acc.light += this.env.light; acc.pump += this.out.pump ? 100 : 0;
      }
      this.history.push([Math.round((startReal + m * 60000) / 1000), ...[acc.t, acc.h, acc.soil, acc.light, acc.pump].map((v, i) => +(v / 60).toFixed(i ? 0 : 1))]);
    }
    this.publish("status", "online");
    this.publishConfig();
    this.publish("history", JSON.stringify(this.history));
    this.publishState();
    this.timers.push(setInterval(() => { if (this.step(TICK_MS)) this.publishState(); }, TICK_MS));
    this.timers.push(setInterval(() => this.publishState(), PUBLISH_MS));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.client.removeListener("message", this.onCmd);
    this.client.unsubscribe(`${this.base}/cmd`);
    this.publish("status", "offline");
  }

  // Toy greenhouse: sunlight heats the air, the fan cools it, the soil dries
  // faster when it is hot, and the pump wets it.
  step(dt) {
    this.clock += dt;
    const phase = (this.clock % DAY_MS) / DAY_MS;              // 0 = 06:00
    const sun = Math.max(0, Math.sin(phase * 2 * Math.PI));
    const e = this.env;
    const noise = () => (Math.random() - 0.5);
    e.light = Math.round(Math.min(100, Math.max(0, sun * 92 + noise() * 4)));
    const targetTemp = 25 + sun * 11 - (this.out.fan ? 3.5 : 0);
    e.temp += (targetTemp - e.temp) * 0.02 * (dt / 1000) + noise() * 0.05;
    e.hum += ((82 - (e.temp - 24) * 2.2) - e.hum) * 0.03 * (dt / 1000) + noise() * 0.2;
    e.soil += ((this.out.pump ? 1.1 : 0) - (0.035 + Math.max(0, e.temp - 26) * 0.012)) * (dt / 1000);
    e.soil = Math.min(100, Math.max(0, e.soil));
    const readings = { temp: e.temp, hum: e.hum, soil: Math.round(e.soil), light: e.light, valid: true };
    const before = this.out;
    this.out = this.ctl.update(readings, this.settings, this.clock);
    return before.pump !== this.out.pump || before.fan !== this.out.fan;
  }

  command(cmd) {
    if (typeof cmd.mode === "string") {
      const auto = cmd.mode === "auto";
      if (!auto && this.settings.autoMode) this.ctl.setManual(this.out.pump, this.out.fan);
      this.settings.autoMode = auto;
    }
    if (!this.settings.autoMode && (typeof cmd.pump === "boolean" || typeof cmd.fan === "boolean")) {
      this.ctl.setManual(typeof cmd.pump === "boolean" ? cmd.pump : this.ctl.pumpWanted, typeof cmd.fan === "boolean" ? cmd.fan : this.ctl.fanWanted);
    }
    const soilMin = cmd.soilMin ?? this.settings.soilMin, tempMax = cmd.tempMax ?? this.settings.tempMax;
    if (settingsValid(soilMin, tempMax)) Object.assign(this.settings, { soilMin, tempMax });
    this.step(0);
    this.publishConfig();
    this.publishState();
  }

  publish(sub, payload) {
    this.client.publish(`${this.base}/${sub}`, payload, { retain: false });
  }

  publishConfig() {
    const s = this.settings;
    this.publish("config", JSON.stringify({ mode: s.autoMode ? "auto" : "manual", soilMin: s.soilMin, tempMax: s.tempMax }));
  }

  publishState() {
    const e = this.env;
    this.publish("state", JSON.stringify({
      ts: Math.round(Date.now() / 1000), t: +e.temp.toFixed(1), h: Math.round(e.hum), sensorOk: true,
      soil: Math.round(e.soil), light: e.light, ...this.out, mode: this.settings.autoMode ? "auto" : "manual",
      rssi: -55 - Math.round(Math.random() * 10), uptime: Math.round((this.clock - this.bootClock) / 1000), fw: "sim",
    }));
  }
}
