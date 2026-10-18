// Host tests for firmware/smartfarm/control.h
// Run: make test   (or: c++ -std=c++17 -Wall -Wextra -o /tmp/control_test test/control_test.cpp && /tmp/control_test)
#include <cstdio>
#include <cstdlib>

#include "../firmware/smartfarm/control.h"

using namespace smartfarm;

static int failures = 0;
#define CHECK(cond)                                                    \
  do {                                                                 \
    if (!(cond)) {                                                     \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);      \
      failures++;                                                      \
    }                                                                  \
  } while (0)

static Readings reading(float temp, int soil) {
  Readings r;
  r.temp = temp;
  r.hum = 60;
  r.soil = soil;
  r.light = 50;
  r.valid = true;
  return r;
}

static void pumpHysteresis() {
  Controller c;
  Settings s;  // soilMin 35
  CHECK(!c.update(reading(25, 40), s, 0).pump);
  CHECK(c.update(reading(25, 34), s, 1000).pump);     // below 35: water
  CHECK(c.update(reading(25, 40), s, 2000).pump);     // still below 45: keep going
  CHECK(!c.update(reading(25, 45), s, 3000).pump);    // reached 35 + 10: stop
  CHECK(!c.update(reading(25, 40), s, 4000).pump);    // between: stay off
}

static void fanHysteresis() {
  Controller c;
  Settings s;  // tempMax 32
  CHECK(!c.update(reading(31, 50), s, 0).fan);
  CHECK(c.update(reading(32.5f, 50), s, 1000).fan);
  CHECK(c.update(reading(31, 50), s, 2000).fan);      // above 30.5: keep cooling
  CHECK(!c.update(reading(30.4f, 50), s, 3000).fan);
}

static void pumpRunLimit() {
  Controller c;
  Settings s;
  CHECK(c.update(reading(25, 10), s, 0).pump);
  CHECK(c.update(reading(25, 10), s, kPumpMaxRunMs - 1).pump);
  Outputs o = c.update(reading(25, 10), s, kPumpMaxRunMs);
  CHECK(!o.pump);
  CHECK(o.pumpResting);
  CHECK(!c.update(reading(25, 10), s, kPumpMaxRunMs + kPumpRestMs - 1).pump);
  CHECK(c.update(reading(25, 10), s, kPumpMaxRunMs + kPumpRestMs).pump);  // rest over: water again
}

static void manualMode() {
  Controller c;
  Settings s;
  s.autoMode = false;
  c.setManual(true, true);
  Outputs o = c.update(reading(20, 90), s, 0);  // wet and cool, but the user wants both on
  CHECK(o.pump && o.fan);
  CHECK(!c.update(reading(20, 90), s, kPumpMaxRunMs).pump);  // safety limit still applies
  c.setManual(false, false);
  o = c.update(reading(40, 5), s, kPumpMaxRunMs + kPumpRestMs);  // hot and dry: manual says off
  CHECK(!o.pump && !o.fan);
}

static void badSensor() {
  Controller c;
  Settings s;
  Readings r = reading(40, 50);
  CHECK(c.update(r, s, 0).fan);
  r.valid = false;
  CHECK(!c.update(r, s, 1000).fan);  // a failed DHT read turns the fan decision off
}

static void millisWrap() {
  Controller c;
  Settings s;
  uint32_t start = 0xFFFFFFFFu - 5000;  // millis() wraps after ~49 days
  CHECK(c.update(reading(25, 10), s, start).pump);
  CHECK(c.update(reading(25, 10), s, start + kPumpMaxRunMs - 1).pump);
  CHECK(!c.update(reading(25, 10), s, start + kPumpMaxRunMs).pump);
}

static void conversions() {
  CHECK(rawToPercent(3200, 3200, 1300) == 0);    // dry
  CHECK(rawToPercent(1300, 3200, 1300) == 100);  // wet
  CHECK(rawToPercent(2250, 3200, 1300) == 50);
  CHECK(rawToPercent(4095, 3200, 1300) == 0);    // clamped
  CHECK(rawToPercent(0, 3200, 1300) == 100);
  CHECK(settingsValid(35, 32));
  CHECK(!settingsValid(5, 32));
  CHECK(!settingsValid(35, 60));
}

int main() {
  pumpHysteresis();
  fanHysteresis();
  pumpRunLimit();
  manualMode();
  badSensor();
  millisWrap();
  conversions();
  if (failures) {
    std::printf("%d check(s) failed\n", failures);
    return EXIT_FAILURE;
  }
  std::printf("all control tests passed\n");
  return EXIT_SUCCESS;
}
