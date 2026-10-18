// The dashboard simulator runs dashboard/control.js, a port of
// firmware/smartfarm/control.h. These cases mirror test/control_test.cpp so the
// two stay in step. Run: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { Controller, PUMP_MAX_RUN_MS, PUMP_REST_MS, settingsValid } from "../dashboard/control.js";

const reading = (temp, soil) => ({ temp, hum: 60, soil, light: 50, valid: true });
const auto = () => ({ soilMin: 35, tempMax: 32, autoMode: true });

test("pump hysteresis", () => {
  const c = new Controller(), s = auto();
  assert.equal(c.update(reading(25, 40), s, 0).pump, false);
  assert.equal(c.update(reading(25, 34), s, 1000).pump, true);
  assert.equal(c.update(reading(25, 40), s, 2000).pump, true);
  assert.equal(c.update(reading(25, 45), s, 3000).pump, false);
  assert.equal(c.update(reading(25, 40), s, 4000).pump, false);
});

test("fan hysteresis", () => {
  const c = new Controller(), s = auto();
  assert.equal(c.update(reading(31, 50), s, 0).fan, false);
  assert.equal(c.update(reading(32.5, 50), s, 1000).fan, true);
  assert.equal(c.update(reading(31, 50), s, 2000).fan, true);
  assert.equal(c.update(reading(30.4, 50), s, 3000).fan, false);
});

test("pump run limit and rest", () => {
  const c = new Controller(), s = auto();
  assert.equal(c.update(reading(25, 10), s, 0).pump, true);
  assert.equal(c.update(reading(25, 10), s, PUMP_MAX_RUN_MS - 1).pump, true);
  const o = c.update(reading(25, 10), s, PUMP_MAX_RUN_MS);
  assert.equal(o.pump, false);
  assert.equal(o.pumpResting, true);
  assert.equal(c.update(reading(25, 10), s, PUMP_MAX_RUN_MS + PUMP_REST_MS - 1).pump, false);
  assert.equal(c.update(reading(25, 10), s, PUMP_MAX_RUN_MS + PUMP_REST_MS).pump, true);
});

test("manual mode keeps the safety limit", () => {
  const c = new Controller(), s = { ...auto(), autoMode: false };
  c.setManual(true, true);
  const o = c.update(reading(20, 90), s, 0);
  assert.ok(o.pump && o.fan);
  assert.equal(c.update(reading(20, 90), s, PUMP_MAX_RUN_MS).pump, false);
  c.setManual(false, false);
  const off = c.update(reading(40, 5), s, PUMP_MAX_RUN_MS + PUMP_REST_MS);
  assert.ok(!off.pump && !off.fan);
});

test("a failed sensor read turns the fan decision off", () => {
  const c = new Controller(), s = auto();
  assert.equal(c.update(reading(40, 50), s, 0).fan, true);
  assert.equal(c.update({ ...reading(40, 50), valid: false }, s, 1000).fan, false);
});

test("settings range", () => {
  assert.ok(settingsValid(35, 32));
  assert.ok(!settingsValid(5, 32));
  assert.ok(!settingsValid(35, 60));
});
