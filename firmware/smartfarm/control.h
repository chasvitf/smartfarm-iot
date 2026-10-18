// Pump and fan control for the greenhouse. Plain C++ with no Arduino calls,
// so test/control_test.cpp can run it on a computer.
#pragma once

#include <stdint.h>

namespace smartfarm {

struct Readings {
  float temp = 0;      // °C
  float hum = 0;       // % RH
  int soil = 0;        // % moisture, 0 = dry, 100 = wet
  int light = 0;       // % light
  bool valid = false;  // false when the DHT22 read failed
};

struct Settings {
  int soilMin = 35;       // water when soil moisture falls below this
  float tempMax = 32.0f;  // fan on above this temperature
  bool autoMode = true;
};

struct Outputs {
  bool pump = false;
  bool fan = false;
  bool pumpResting = false;  // pump wanted but held off by the run-time limit
};

// Hysteresis and safety limits.
constexpr int kSoilHysteresis = 10;           // pump stops at soilMin + 10 %
constexpr float kTempHysteresis = 1.5f;       // fan stops at tempMax - 1.5 °C
constexpr uint32_t kPumpMaxRunMs = 60000;     // never pump longer than 1 minute in one go
constexpr uint32_t kPumpRestMs = 30000;       // then let the water soak in for 30 s

inline bool settingsValid(int soilMin, float tempMax) {
  return soilMin >= 10 && soilMin <= 80 && tempMax >= 20 && tempMax <= 45;
}

class Controller {
 public:
  // Auto mode: decide from the readings. Manual mode: keep what the user set.
  // In both modes the pump run-time limit applies, so a stuck sensor or a
  // forgotten manual switch cannot run the pump dry.
  Outputs update(const Readings& r, const Settings& s, uint32_t now) {
    if (s.autoMode) {
      if (r.valid) {
        if (r.temp > s.tempMax) fanWanted_ = true;
        else if (r.temp < s.tempMax - kTempHysteresis) fanWanted_ = false;
      } else {
        fanWanted_ = false;  // no temperature, no fan decision
      }
      if (r.soil < s.soilMin) pumpWanted_ = true;
      else if (r.soil >= s.soilMin + kSoilHysteresis) pumpWanted_ = false;
    }

    Outputs out;
    out.fan = fanWanted_;
    // Elapsed-time checks (now - start) stay correct when millis() wraps.
    if (resting_ && now - restStart_ >= kPumpRestMs) resting_ = false;
    if (pumpWanted_ && !resting_) {
      if (!pumpOn_) pumpSince_ = now;
      pumpOn_ = true;
      if (now - pumpSince_ >= kPumpMaxRunMs) {
        pumpOn_ = false;
        resting_ = true;
        restStart_ = now;
      }
    } else {
      pumpOn_ = false;
    }
    out.pump = pumpOn_;
    out.pumpResting = pumpWanted_ && resting_;
    return out;
  }

  // Manual switches from the dashboard or the button.
  void setManual(bool pump, bool fan) {
    pumpWanted_ = pump;
    fanWanted_ = fan;
  }

  bool pumpWanted() const { return pumpWanted_; }
  bool fanWanted() const { return fanWanted_; }

 private:
  bool pumpWanted_ = false;
  bool fanWanted_ = false;
  bool pumpOn_ = false;
  bool resting_ = false;
  uint32_t pumpSince_ = 0;
  uint32_t restStart_ = 0;
};

// Raw ADC value to percent, for sensors where the reading falls as the value rises
// (capacitive soil sensors read high when dry). Clamped to 0..100.
inline int rawToPercent(int raw, int rawAt0, int rawAt100) {
  if (rawAt0 == rawAt100) return 0;
  long pct = long(raw - rawAt0) * 100 / (rawAt100 - rawAt0);
  return pct < 0 ? 0 : pct > 100 ? 100 : int(pct);
}

}  // namespace smartfarm
