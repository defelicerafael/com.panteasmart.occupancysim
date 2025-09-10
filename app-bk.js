'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

// === Ajustes rápidos ===
const DAYS_BACK = 5; // Ventana de búsqueda
const ZONES_ARRAY = ['Dormitorio'];
//const ZONES_ARRAY = ['1. Living', '2. Cocina', '3. Playroom'];

module.exports = class MyApp extends Homey.App {
  async onInit() {
    this.log('MyApp has been initialized');
    try {
      // Inicializar la API de Homey
      this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });
      this.appSettings = await this.homey.settings.get("settings") || {};

      // Procesar cada zona en ZONES_ARRAY
      for (const zoneName of ZONES_ARRAY) {
        this.log(`\n🔍 Procesando zona: ${zoneName}`);

        // Obtener luces en la zona
        const lightsInZone = this.getLightsByZone(zoneName);
        if (!lightsInZone.length) {
          this.log(`No se encontraron luces en la zona "${zoneName}".`);
          continue;
        }

        // Obtener historial real de las luces en la zona
        const historyByZone = await this.getHistoryByZone(zoneName);

        // Mostrar el historial agrupado por zona
        this.log(`Historial de la zona "${zoneName}":`, JSON.stringify(historyByZone, null, 2));
      }
    } catch (err) {
      this.error('Error al inicializar:', err);
    }
  }

  /**
   * Obtener luces en una zona específica
   */
  getLightsByZone(zoneName) {
    const lightsInZone = fakeDevices.filter(device => device.zone === zoneName);
    if (!lightsInZone.length) {
      this.log(`No se encontraron luces en la zona "${zoneName}".`);
      return [];
    }
    this.log(`Luces en la zona "${zoneName}":`, lightsInZone.map(light => light.name));
    return lightsInZone;
  }

  /**
   * Obtener historial real de las luces en una zona
   */
  async getHistoryByZone(zoneName) {
    const lightsInZone = this.getLightsByZone(zoneName);
    if (!lightsInZone.length) {
      return [];
    }

    const historyByZone = [];

    for (const light of lightsInZone) {
      const lightHistory = {
        deviceId: light.id,
        name: light.name,
        zone: light.zone,
        logs: {}
      };

      for (const entry of fakeHistory) {
        if (entry.capability !== 'onoff') continue; // Ignorar entradas que no sean de "onoff"
        const day = entry.dayOfWeek;
        const hour = entry.time.split(':')[0] + ':00'; // Redondear a la hora

        if (!lightHistory.logs[day]) {
          lightHistory.logs[day] = {};
        }

        lightHistory.logs[day][hour] = {
          value: entry.value,
          durationInState: entry.durationInState,
        };
      }

      historyByZone.push(lightHistory);
    }

    this.log(`Historial de la zona "${zoneName}":`, JSON.stringify(historyByZone, null, 2));
    return historyByZone;
  }

  // === Helpers de Insights ===

  _findLogMeta(allLogs, deviceId, capability) {
    const devTag = `device:${deviceId}`;
    return Object.values(allLogs).find(l =>
      (l.ownerUri && l.ownerUri.includes(devTag)) &&
      (l.ownerId === capability || (l.id && l.id.endsWith(`:${capability}`)))
    );
  }

  async _fetchCapabilityHistory(deviceId, capability, logMeta) {
    const idFull = (logMeta && logMeta.id) ? logMeta.id : `homey:device:${deviceId}:${capability}`;
    const dateEnd = new Date().toISOString();
    const dateStart = new Date(Date.now() - DAYS_BACK * 864e5).toISOString();

    this.log(`\n🔎 ${capability} — intentando recuperar histórico`);
    const attempts = [
      { tag: 'win:none', payload: { id: idFull, dateStart, dateEnd, aggregation: 'none', limit: 5000 } },
    ];

    for (const a of attempts) {
      try {
        this.log(`Intentando getLogEntries con: ${JSON.stringify(a.payload)}`);
        const res = await homeyApi.insights.getLogEntries(a.payload);
        const values = Array.isArray(res?.values) ? res.values
          : Array.isArray(res?.entries) ? res.entries
          : Array.isArray(res?.data) ? res.data
          : Array.isArray(res) ? res
          : [];

        if (!values.length) {
          this.log(`   (sin entries) [${a.tag}]`);
          continue;
        }
        this.log(`   ✅ ${values.length} entries [${a.tag}]`);

        return values;
      } catch (err) {
        this.log(`   ❌ Error: ${err.message || err}`);
      }
    }

    this.log('   (No hay eventos dentro del período solicitado).');
    return [];
  }

  // === Resúmenes y “gráficos” ===

  _summarizeBoolean(capability, values) {
    const sorted = [...values].sort((a, b) => (this._ts(a) - this._ts(b)));

    const perDayCount = new Map();
    const perDayOnSec = new Map();
    let flips = 0;
    let lastVal = null;
    let lastTrueStart = null;

    for (const e of sorted) {
      const t = this._ts(e);
      const v = this._val(e);
      const day = this._dayKey(new Date(t));

      if (lastVal === null) lastVal = v;

      if (lastVal === false && v === true) {
        flips++;
        perDayCount.set(day, (perDayCount.get(day) || 0) + 1);
        lastTrueStart = t;
      }

      if (lastVal === true && v === false && lastTrueStart != null) {
        const dsec = Math.max(0, Math.floor((t - lastTrueStart) / 1000));
        const startDay = this._dayKey(new Date(lastTrueStart));
        perDayOnSec.set(startDay, (perDayOnSec.get(startDay) || 0) + dsec);
        lastTrueStart = null;
      }

      lastVal = v;
    }

    if (lastVal === true && lastTrueStart != null) {
      const now = Date.now();
      const dsec = Math.max(0, Math.floor((now - lastTrueStart) / 1000));
      const startDay = this._dayKey(new Date(lastTrueStart));
      perDayOnSec.set(startDay, (perDayOnSec.get(startDay) || 0) + dsec);
    }

    this.log(`   🔁 Cambios detectados: ${flips}`);
  }

  // === Utilidades de tiempo/valor ===

  _ts(e) {
    const t = e.t ?? e.timestamp ?? e.time ?? e.ts ?? e.date;
    return isNaN(Number(t)) ? Date.parse(t) : Number(t);
  }

  _val(e) {
    const v = e.v ?? e.value ?? e.val;
    return v;
  }

  _dayKey(d) {
    return this.fmtYMD.format(d);
  }

  _hourKey(d) {
    const ymd = this.fmtYMD.format(d);
    const hm = this.fmtHM.format(d).slice(0, 2);
    return `${ymd} ${hm}:00`;
  }

  _lastNDaysKeys(n) {
    const arr = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      arr.push(this._dayKey(d));
    }
    return arr;
  }

  _bar(value, vmax, width = 20) {
    const len = vmax ? Math.round((value / vmax) * width) : 0;
    return '▇'.repeat(len).padEnd(width, ' ');
  }

  _fmtDur(sec) {
    if (sec <= 0) return '0s';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }
};
