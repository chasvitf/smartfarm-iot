// JavaScript port of firmware/smartfarm/control.h, used by the in-browser
// simulator so it behaves exactly like the board. Keep the two in sync.

export const SOIL_HYSTERESIS = 10;
export const TEMP_HYSTERESIS = 1.5;
export const PUMP_MAX_RUN_MS = 60000;
export const PUMP_REST_MS = 30000;

export function settingsValid(soilMin, tempMax) {
  return soilMin >= 10 && soilMin <= 80 && tempMax >= 20 && tempMax <= 45;
}

export class Controller {
  pumpWanted = false;
  fanWanted = false;
  pumpOn = false;
  resting = false;
  pumpSince = 0;
  restStart = 0;

  update(r, s, now) {
    if (s.autoMode) {
      if (r.valid) {
        if (r.temp > s.tempMax) this.fanWanted = true;
        else if (r.temp < s.tempMax - TEMP_HYSTERESIS) this.fanWanted = false;
      } else {
        this.fanWanted = false;
      }
      if (r.soil < s.soilMin) this.pumpWanted = true;
      else if (r.soil >= s.soilMin + SOIL_HYSTERESIS) this.pumpWanted = false;
    }
    if (this.resting && now - this.restStart >= PUMP_REST_MS) this.resting = false;
    if (this.pumpWanted && !this.resting) {
      if (!this.pumpOn) this.pumpSince = now;
      this.pumpOn = true;
      if (now - this.pumpSince >= PUMP_MAX_RUN_MS) {
        this.pumpOn = false;
        this.resting = true;
        this.restStart = now;
      }
    } else {
      this.pumpOn = false;
    }
    return { pump: this.pumpOn, fan: this.fanWanted, pumpResting: this.pumpWanted && this.resting };
  }

  setManual(pump, fan) {
    this.pumpWanted = pump;
    this.fanWanted = fan;
  }
}
