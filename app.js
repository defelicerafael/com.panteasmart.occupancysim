'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

const CONTROL_DRIVER_ID = 'occupancy_logger_switch';
const ARG_TIMEZONE = 'America/Argentina/Buenos_Aires';

module.exports = class MyApp extends Homey.App {
  async onInit() {
    try {
      this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });
      console.log(" Homey API inicializada correctamente.");
      this.user = await this.homeyApi.users.getUserMe();
      console.log(" Usuario cargado:", this.user);
      this.systemInfo = await this.homeyApi.system.getInfo();
      console.log(" System Info:", this.systemInfo);
      
      this.fmtYMD = new Intl.DateTimeFormat('sv-SE', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: ARG_TIMEZONE,
      });
      this.fmtHM = new Intl.DateTimeFormat('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: ARG_TIMEZONE,
      });
      // Nuevo formateador con segundos
      this.fmtHMS = new Intl.DateTimeFormat('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: ARG_TIMEZONE,
      });

      this.switchOnTimestamp = null;
      this.eventosGuardados = 0;
      this.enabled = true;
      this.controlSwitchListener = null;
      this.controlSwitchDeviceId = null;
      this.controlSwitchMissingLogged = false;
      this.lightListeners = new Map();
      this.zones = null;

      await this._refreshDevices();

      this.homeyApi.devices.on('device.create', async ({ id }) => {
        try {
          await this._refreshDevices();
        } catch (err) {
          this.error(`Error procesando device.create (${id}): ${err.message}`);
        }
      });

      this.homeyApi.devices.on('device.delete', async ({ id }) => {
        try {
          await this._handleDeviceDeleted(id);
        } catch (err) {
          this.error(`Error procesando device.delete (${id}): ${err.message}`);
        }
      });
    } catch (err) {
      this.error('Error al inicializar:', err);
    }
  }

  async _refreshDevices() {
    this.devices = await this.homeyApi.devices.getDevices();
    this.zones = null;
    await this._ensureZonesCache();
    await this._ensureControlSwitch();
    this._syncLightListeners();
  }

  async _ensureZonesCache() {
    if (this.zones && typeof this.zones === 'object' && Object.keys(this.zones).length > 0) {
      return;
    }
    try {
      this.zones = await this.homeyApi.zones.getZones();
    } catch (err) {
      this.zones = null;
      this.log(`No se pudo actualizar la cache de zonas: ${err.message}`);
    }
  }

  async _resolveZoneContext(zoneId) {
    const fallback = {
      id: zoneId ?? null,
      name: 'Sin zona',
      path: 'Sin zona',
    };

    if (!zoneId) {
      return fallback;
    }

    await this._ensureZonesCache();
    let zones = this.zones;
    if (!zones || typeof zones !== 'object') {
      zones = {};
      this.zones = zones;
    }
    const visited = new Set();
    const names = [];
    let currentId = zoneId;
    let leafZone = null;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      let zone = zones[currentId];
      if (!zone) {
        try {
          zone = await this.homeyApi.zones.getZone({ id: currentId });
          if (zone) {
            zones[currentId] = zone;
          }
        } catch (err) {
          this.log(`No se pudo obtener la zona ${currentId}: ${err.message}`);
          break;
        }
      }

      if (!zone) {
        break;
      }

      if (!leafZone) leafZone = zone;
      names.push(zone.name ?? `Zona ${currentId}`);
      currentId = zone.parent;
    }

    if (!names.length || !leafZone) {
      return fallback;
    }

    const path = names.slice().reverse().join(' / ');

    return {
      id: leafZone.id ?? zoneId,
      name: leafZone.name ?? fallback.name,
      path,
    };
  }

  async _ensureControlSwitch() {
  // 1) Buscar el switch con varias heurísticas (driverId/driverUri/nombre)
  const controlSwitch = Object.values(this.devices).find(d =>
    d.driverId === CONTROL_DRIVER_ID ||
    (typeof d.driverId === 'string' && d.driverId.endsWith(':' + CONTROL_DRIVER_ID)) ||
    (typeof d.driverUri === 'string' && d.driverUri.endsWith(':' + CONTROL_DRIVER_ID)) ||
    d.name === 'Occupancy Logger Switch'
  );

  if (!controlSwitch) {
    if (this.controlSwitchListener?.destroy) this.controlSwitchListener.destroy();
    this.controlSwitchListener = null;
    this.controlSwitchDeviceId = null;
    this.enabled = true;
    if (!this.controlSwitchMissingLogged) {
      this.log('⚠️ No se encontró "Occupancy Logger Switch". El guardado queda habilitado por defecto.');
      this.controlSwitchMissingLogged = true;
    }
    return;
  }

  this.controlSwitchMissingLogged = false;
  this.controlSwitchDeviceId = controlSwitch.id;
  this.enabled = controlSwitch.capabilitiesObj?.onoff?.value ?? true;

  // 2) Usar SIEMPRE el device del Web API para makeCapabilityInstance
  if (this.controlSwitchListener?.destroy) this.controlSwitchListener.destroy();

  this.controlSwitchListener = controlSwitch.makeCapabilityInstance('onoff', async value => {
    this.enabled = !!value;
    this.log(`Occupancy logger ${value ? 'enabled' : 'disabled'}`);
    if (value) {
      this.switchOnTimestamp = Date.now();
      this.eventosGuardados = 0;
      // si querés noti:
      // await this.homey.notifications.createNotification({ excerpt: 'Comenzamos a guardar los eventos de las luces.' });
    } else {
      this.switchOnTimestamp = null;
      // await this.homey.notifications.createNotification({ excerpt: 'Se detuvo el guardado de eventos de las luces.' });
    }
  });
}


  _syncLightListeners() {
    const knownLightIds = new Set();

    Object.values(this.devices).forEach(device => {
     
      if (!Array.isArray(device.capabilities) || !device.capabilities.includes('onoff')) return;

      knownLightIds.add(device.id);

      if (!this.lightListeners.has(device.id)) {
        const capabilityInstance = device.makeCapabilityInstance('onoff', async value => {
          const entry = this.lightListeners.get(device.id);
          const currentDevice = entry?.device || device;
          await this._handleLightOnOff(currentDevice, value);
        });
        this.lightListeners.set(device.id, { device, capabilityInstance });
      } else {
        const entry = this.lightListeners.get(device.id);
        entry.device = device;
      }
    });

    for (const [deviceId, entry] of this.lightListeners.entries()) {
      if (!knownLightIds.has(deviceId)) {
        entry.capabilityInstance?.destroy?.();
        this.lightListeners.delete(deviceId);
      }
    }
  }

  async _handleDeviceDeleted(deviceId) {
    if (this.controlSwitchDeviceId === deviceId) {
      if (this.controlSwitchListener?.destroy) {
        this.controlSwitchListener.destroy();
      }
      this.controlSwitchListener = null;
      this.controlSwitchDeviceId = null;
      this.enabled = true;
    }

    const entry = this.lightListeners.get(deviceId);
    if (entry) {
      entry.capabilityInstance?.destroy?.();
      this.lightListeners.delete(deviceId);
    }

    await this._refreshDevices();
  }

  async _handleLightOnOff(device, value) {
    try {
      if (!this.enabled) return;

      const now = new Date();
      const nowIso = now.toISOString();
      const lightVarName = `light_${device.id}`;
      let state = await this.homey.settings.get(lightVarName);

      if (!state) {
        state = { lastOnOffState: null, lastUpdate: null, lastOnTimestamp: null };
      }

      if (state.lastOnOffState === value) return;

      state.lastOnOffState = value;
      state.lastUpdate = nowIso;

      if (value) {
        state.lastOnTimestamp = nowIso;
        await this.homey.settings.set(lightVarName, state);
        return;
      }

      let onTimestamp = null;
      if (state.lastOnTimestamp) {
        const parsed = new Date(state.lastOnTimestamp);
        if (!Number.isNaN(parsed.getTime())) {
          onTimestamp = parsed;
        }
      }
      if (!onTimestamp) {
        onTimestamp = now;
      }

      const durationOnSeconds = (() => {
        const diffMs = now - onTimestamp;
        if (diffMs <= 0) return 0; // fallback, no tiempo transcurrido
        let secs = Math.floor(diffMs / 1000); // quitar milisegundos
        if (secs < 1) secs = 1; // asegurar distinto de cero si hubo cambio
        return secs;
      })();

      state.lastOnTimestamp = null;
      await this.homey.settings.set(lightVarName, state);

      const { name: zoneName, id: zoneId, path: zonePath } = await this._resolveZoneContext(device.zone);

      const logEntry = {
        event_date: this.fmtYMD.format(onTimestamp),
        day_of_week: onTimestamp.toLocaleDateString('es-ES', { weekday: 'long', timeZone: ARG_TIMEZONE }),
        month_name: onTimestamp.toLocaleDateString('es-ES', { month: 'long', timeZone: ARG_TIMEZONE }),
        event_time: this.fmtHMS.format(onTimestamp), // ahora con segundos reales
        value_bool: !!value,
        duration_in_state_seconds: durationOnSeconds,
        zone: zoneName,
        zone_id: zoneId,
        zone_path: zonePath,
        deviceId: device.id,
        name: device.name,
        user_id: this.user?.id ?? null,
        user_name: this.user?.name ?? null,
      };

      await this.guardarDatosDeLaSemana(logEntry);
    } catch (err) {
      this.error(`Error guardando evento onoff: ${err.message}`);
    }
  }

  async guardarDatosDeLaSemana(logEntry) {
    if (!logEntry || typeof logEntry !== 'object') return;
    try {
      const response = await fetch('https://panteasmart.com.ar/server/insert_array.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          tabla: 'simulator',
          datos: JSON.stringify(logEntry)
        })
      });

      const rawResponse = await response.text();
      let result;
      try {
        result = JSON.parse(rawResponse);
      } catch (err) {
        throw new Error(`La respuesta no es JSON valido: ${rawResponse}`);
      }

      if (result.error !== '0') {
        this.error('Error guardando log:', result);
      } else {
        this.eventosGuardados = (this.eventosGuardados || 0) + 1;
        if (this.eventosGuardados % 10 === 0 && this.switchOnTimestamp) {
          const minutos = Math.floor((Date.now() - this.switchOnTimestamp) / 60000);
          this.log(`Guardados ${this.eventosGuardados} eventos en ${minutos} minutos.`);
        }
      }
    } catch (error) {
      this.error('Error en la conexion con la API de Pantea Smart:', error);
    }
  }
};
