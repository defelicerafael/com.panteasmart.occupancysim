'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

// === Ajustes rápidos ===
const DAYS_BACK = 5; // Ventana de búsqueda
const ZONES_ARRAY = ['1. Living', '2. Cocina', '3. Playroom'];
const CAPABILITY = 'onoff';


module.exports = class MyApp extends Homey.App {
  async onInit() {
  this.log('MyApp has been initialized');
  try {
    this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });
    this.appSettings = await this.homey.settings.get('settings') || {};

    // Formatters
    this.fmtYMD = new Intl.DateTimeFormat('es-AR', { year: 'numeric', month: '2-digit', day: '2-digit' });
    this.fmtHM  = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });

    // Precargar devices y zonas
    const devicesObj = await this.homeyApi.devices.getDevices();
    const zonesObj   = await this.homeyApi.zones.getZones();

    // Log de todas las zonas disponibles
    this.log('🔍 Zonas disponibles:');
    Object.values(zonesObj).forEach(zone => {
      this.log(`- ${zone.name} (ID: ${zone.id})`);
    });

    // Procesar cada zona en ZONES_ARRAY
    for (const zoneName of ZONES_ARRAY) {
      this.log(`\n🔍 Procesando zona: ${zoneName}`);

      const lightsInZone = this.getLightsByZoneReal(devicesObj, zonesObj, zoneName);
      if (!lightsInZone.length) {
        this.log(`No se encontraron luces en la zona "${zoneName}".`);
        continue;
      }

      const historyByZone = await this.getHistoryByZoneReal(lightsInZone);
      this.log(`Historial de la zona "${zoneName}":`, JSON.stringify(historyByZone, null, 2));
    }
  } catch (err) {
    this.error('Error al inicializar:', err);
  }
}


  /**
   * Obtener luces en una zona específica
   */
  getLightsByZoneReal(devicesObj, zonesObj, zoneName) {
    const devices = Object.values(devicesObj);
    const zoneIdByName = Object.values(zonesObj).find(z => z.name === zoneName)?.id;

    if (!zoneIdByName) {
      this.log(`Zona no encontrada por nombre: "${zoneName}"`);
      return [];
    }

    
    /*const allDevicesInZone = devices.filter(d => d.zone === zoneIdByName);
    this.log(`Luces en la zona "${zoneName}":`, allDevicesInZone.map(l => l.name));
    return allDevicesInZone.map(d => ({ id: d.id, name: d.name, zone: zoneName }));*/
  

    const lights = devices.filter(d =>
      d.zone === zoneIdByName &&
      (d.class === 'light' || d.capabilitiesObj?.onoff) // heurística por si es socket/driver custom
    );

    this.log(`Luces en la zona "${zoneName}":`, lights.map(l => l.name));
    return lights.map(d => ({ id: d.id, name: d.name, zone: zoneName }));
    
  }


  async getHistoryByZoneReal(lightsInZone) {
    const dateEnd = new Date().toISOString();
    const dateStart = new Date(Date.now() - DAYS_BACK * 864e5).toISOString();

    const history = [];

    // Cargar índice de logs una sola vez para acelerar (_findLogMeta puede usarlo)
    const allLogs = await this.homeyApi.insights.getLogs();

    await Promise.all(lightsInZone.map(async light => {
      const lightHistory = { deviceId: light.id, name: light.name, zone: light.zone, logs: [] };

      // 1) Obtener log para la capacidad especificada
      const logMeta =
        this._findLogMeta(allLogs, light.id, CAPABILITY) ||
        { id: `homey:device:${light.id}:${CAPABILITY}` }; // intento directo

      // 2) Leer entradas
      const entries = await this._fetchCapabilityHistoryReal(light.id, CAPABILITY, logMeta, dateStart, dateEnd);
      if (!entries.length) {
        this.log(`No se encontraron entradas para "${light.name}".`);
        history.push(lightHistory);
        return;
      }

      // 3) Procesar entradas
      for (const e of entries) {
        const t = this._ts(e); // Timestamp
        const v = !!this._val(e); // Valor booleano
        if (!Number.isFinite(t)) continue;

        const d = new Date(t);

        // Formatear los datos
        const logEntry = {
          date: this.fmtYMD.format(d), // Fecha en formato YYYY-MM-DD
          dayOfWeek: d.toLocaleDateString('es-ES', { weekday: 'long' }), // Día de la semana
          month: d.toLocaleDateString('es-ES', { month: 'long' }), // Mes
          time: this.fmtHM.format(d), // Hora en formato HH:mm
          value: v, // Valor booleano
          durationInState: e.durationInState || null // Duración en estado (si está disponible)
        };

        lightHistory.logs.push(logEntry);
      }

      history.push(lightHistory);
    }));

    return history;
  }


  

  async _fetchCapabilityHistoryReal(deviceId, capability, logMeta, dateStart, dateEnd) {
    const idFull = (logMeta && logMeta.id) ? logMeta.id : `homey:device:${deviceId}:${capability}`;

    const payloads = [
      { id: idFull, dateStart, dateEnd, aggregation: 'none', limit: 5000 },
      // opcional: otras agregaciones si te sirven (mean/sum/bucket)
    ];

    for (const p of payloads) {
      try {
        const res = await this.homeyApi.insights.getLogEntries(p);
        const values = Array.isArray(res?.values) ? res.values
          : Array.isArray(res?.entries) ? res.entries
          : Array.isArray(res?.data) ? res.data
          : Array.isArray(res) ? res
          : [];
        if (values.length) return values;
      } catch (err) {
        this.log(`Insights error (${idFull}): ${err.message || err}`);
      }
    }
    return [];
  }

  // === Helpers de Insights ===

// === Helpers de Insights ===
_findLogMeta(allLogs, deviceId, capability) {
  const devTag1 = `homey:device:${deviceId}`;
  const devTag2 = `device:${deviceId}`; // por si tu lib devuelve este formato

  return Object.values(allLogs).find(l => {
    const uri = l.uri || l.ownerUri || '';
    const id = l.id || '';
    const ownerId = l.ownerId || '';
    const matchesDevice = uri.includes(devTag1) || uri.includes(devTag2);
    const matchesCap = id.endsWith(`:${capability}`) || ownerId === capability;
    return matchesDevice && matchesCap;
  });
}


  _dayKey(d) {
  return this.fmtYMD.format(d); // "dd/mm/aaaa" en es-AR
}
_hourKey(d) {
  const hm = this.fmtHM.format(d); // "HH:mm"
  const hh = hm.slice(0, 2);
  return `${hh}:00`; // redondeo a hora
}
_ts(e) {
  const t = e.t ?? e.timestamp ?? e.time ?? e.ts ?? e.date;
  const n = isNaN(Number(t)) ? Date.parse(t) : Number(t);
  return Number.isFinite(n) ? n : NaN;
}
_val(e) {
  let v = e.v ?? e.value ?? e.val;
  // Normalizar: algunos logs devuelven "1"/"0" o 1/0 para boolean
  if (v === 1 || v === '1') v = true;
  if (v === 0 || v === '0') v = false;
  return v;
}

};
