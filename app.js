'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

const CONTROL_DRIVER_ID = 'occupancy_logger_switch';
const ARG_TIMEZONE = 'America/Argentina/Buenos_Aires';

module.exports = class MyApp extends Homey.App {
  async onInit() {
    try {
      this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });
      //console.log(" Homey API inicializada correctamente.");
      this.user = await this.homeyApi.users.getUserMe();
      //console.log(" Usuario cargado:", this.user);
      this.systemInfo = await this.homeyApi.system.getInfo();
      //console.log(" System Info:", this.systemInfo);
      
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

      // CARGAMOS LOS SETTINGS DEL SIMULADOR

      await this.cargarSimulatorConfig();
      await this.cargarDatosSimulador();

      const sun = await this.getSunTimes();
      if (sun) {
        const rango = this.calcularRangoSimulacion(sun.sunriseUTC, sun.sunsetUTC);
      }
      // FIN DE LA CARGA DE SETTINGS DEL SIMULADOR
      
      
      
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

  /* PROCESOS DEL SIMULADOR */

  // llamamos al settings y guardamos las variables internas

  async cargarSimulatorConfig() {
    try {
      const simulatorSettings = await this.homey.settings.get('SimulatorSettings');

      if (!simulatorSettings || !simulatorSettings.simulatorConfig) {
        this.log('⚠️ No se encontró simulatorConfig en settings.');
        return;
      }

      const cfg = simulatorSettings.simulatorConfig;

      // Guardar cada valor como propiedad interna
      this.simulation_coverage = cfg.simulation_coverage ?? 0;
      this.on_duration = cfg.on_duration ?? 0;
      this.random_start_delay_minutes = cfg.random_start_delay_minutes ?? 0;
      this.AllDaySimulation = cfg.AllDaySimulation ?? false;
      this.BeforeSunsetStartSimulation = cfg.BeforeSunsetStartSimulation ?? 0;
      this.AfterSunriseEndSimulation = cfg.AfterSunriseEndSimulation ?? 0;

      // Mostrar en logs para control
      //this.log('🧠 Configuración del simulador cargada:');
      /*this.log({
        simulation_coverage: this.simulation_coverage,
        on_duration: this.on_duration,
        random_start_delay_minutes: this.random_start_delay_minutes,
        AllDaySimulation: this.AllDaySimulation,
        BeforeSunsetStartSimulation: this.BeforeSunsetStartSimulation,
        AfterSunriseEndSimulation: this.AfterSunriseEndSimulation,
      });*/
    } catch (err) {
      this.error('Error al cargar simulatorConfig:', err);
    }
  }


  // CARGA LOS DATOS DEL SIMULADOR EN UN ARRAY 
  async cargarDatosSimulador() {
    try {
      const simulatorSettings = await this.homey.settings.get('SimulatorSettings');
      if (!simulatorSettings || !simulatorSettings.simulator) {
        this.log('⚠️ No se encontraron datos del simulador en settings.');
        this.simulatorData = [];
        return;
      }

      let simulatorRaw = simulatorSettings.simulator;
      let simulatorParsed;

      // Si el valor viene como string JSON → parsearlo
      if (typeof simulatorRaw === 'string') {
        try {
          simulatorParsed = JSON.parse(simulatorRaw);
        } catch (err) {
          this.error('❌ Error al parsear el campo simulator:', err.message);
          this.simulatorData = [];
          return;
        }
      } else {
        simulatorParsed = simulatorRaw;
      }

      // Validar estructura esperada
      if (!simulatorParsed.simulator || !Array.isArray(simulatorParsed.simulator)) {
        this.log('⚠️ Estructura del simulador inesperada.');
        this.simulatorData = [];
        return;
      }

      // Guardar los datos en memoria
      this.simulatorData = simulatorParsed.simulator;

      this.log(`✅ Cargados ${this.simulatorData.length} eventos del simulador.`);
      //this.log('📋 Primeros 3 eventos:');
      //this.log(JSON.stringify(this.simulatorData.slice(0, 3), null, 2));

    } catch (err) {
      this.error('Error cargando datos del simulador:', err);
      this.simulatorData = [];
    }
  }

  // ME FIJO LA UBICACION DE HOMEY PARA SACAR LA HRA DE ATARDECER Y AMANECER
  async getSunTimes() {
    try {
      // --- Obtener coordenadas desde Homey ---
      const lat = this.homey.geolocation.getLatitude();
      const lon = this.homey.geolocation.getLongitude();
      const mode = this.homey.geolocation.getMode();

      this.log(`📍 Ubicación Homey (${mode}): lat=${lat}, lon=${lon}`);

      // Fallback si faltan coordenadas
      const latitude = (lat && !isNaN(lat)) ? lat : -34.6037;
      const longitude = (lon && !isNaN(lon)) ? lon : -58.3816;

      // --- Construir URL con fecha actual ---
      const today = new Date();
      const dateStr = today.toISOString().split('T')[0];
      const url = `https://api.sunrise-sunset.org/json?lat=${latitude}&lng=${longitude}&date=${dateStr}&formatted=0`;
      this.log('🔗 URL llamada:', url);

      // --- Llamada a la API ---
      const response = await fetch(url);
      const data = await response.json();

      if (data.status !== 'OK') throw new Error('Respuesta inválida de la API.');

      // --- Convertir UTC → hora local correctamente ---
      const tz = this.systemInfo?.timezone ?? 'America/Argentina/Buenos_Aires';
      const fmt = new Intl.DateTimeFormat('es-AR', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });

      const sunriseUTC = new Date(data.results.sunrise);
      const sunsetUTC  = new Date(data.results.sunset);

      const sunriseLocal = fmt.format(sunriseUTC);
      const sunsetLocal  = fmt.format(sunsetUTC);

      this.log(`🌅 Amanecer local (${tz}): ${sunriseLocal}`);
      this.log(`🌇 Atardecer local (${tz}): ${sunsetLocal}`);

      // --- Devolver ambos valores UTC + string local ---
      return { sunriseUTC, sunsetUTC, sunriseLocal, sunsetLocal };

    } catch (err) {
      this.error('Error obteniendo horas de sol:', err);
      return null;
    }
  }

  calcularRangoSimulacion(sunrise, sunset) {
    try {
      if (!sunrise || !sunset) {
        this.error('❌ No se pasaron valores de amanecer/atardecer válidos.');
        return null;
      }

      // Obtener minutos desde settings (ya cargados en this)
      const beforeSunsetMin = this.BeforeSunsetStartSimulation ?? 0;
      const afterSunriseMin = this.AfterSunriseEndSimulation ?? 0;

      // Calcular horarios ajustados
      const startTime = new Date(sunset.getTime() - beforeSunsetMin * 60000);
      const endTime   = new Date(sunrise.getTime() + afterSunriseMin * 60000);

      // Formatear para mostrar
      const fmt = new Intl.DateTimeFormat('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: this.systemInfo?.timezone ?? 'America/Argentina/Buenos_Aires'
      });

      this.log('🕓 Rango de simulación calculado:');
      this.log(`   Inicio → ${fmt.format(startTime)} ( ${beforeSunsetMin} min antes del atardecer )`);
      this.log(`   Fin    → ${fmt.format(endTime)} ( ${afterSunriseMin} min después del amanecer )`);

      return { startTime, endTime };

    } catch (err) {
      this.error('Error calculando rango de simulación:', err);
      return null;
    }
  }


  /* ================================
   🔹 SIMULACIÓN - FUNCIONES PRINCIPALES
   ================================ */

// llamada desde el dispositivo (Occupancy Logger Switch)
async iniciarSimulacionDesdeDevice(device) {
  try {
    this.log(`🎬 [${device.getName()}] → Iniciando simulación desde dispositivo`);

    // 🧠 Si el modo "todo el día" está activo → arranca ya
    if (this.AllDaySimulation) {
      const msg = '☀️ Modo “Todo el día” activo: la simulación comienza ahora.';
      this.log(msg);
      await device.setWarning(msg);
      await this.homey.notifications.createNotification({ excerpt: msg });
      await this.ejecutarSimulacion(device);
      return;
    }

    // Obtener horarios de sol
    const sun = await this.getSunTimes();
    if (!sun) throw new Error('No se pudieron obtener los horarios del sol.');

    const rango = this.calcularRangoSimulacion(sun.sunriseUTC, sun.sunsetUTC);
    if (!rango) throw new Error('No se pudo calcular el rango.');

    const now = new Date();
    const tz = this.systemInfo?.timezone ?? 'America/Argentina/Buenos_Aires';
    const fmt = new Intl.DateTimeFormat('es-AR', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    let msg;
    if (now >= rango.startTime && now <= rango.endTime) {
      msg = '🚀 La simulación comienza ahora.';
      await device.setWarning(msg);
      await this.homey.notifications.createNotification({ excerpt: msg });
      await this.ejecutarSimulacion(device);
    } else if (now < rango.startTime) {
      const diff = rango.startTime - now;
      const minutos = Math.round(diff / 60000);
      msg = `🕕 La simulación comenzará a las ${fmt.format(rango.startTime)} (en ${minutos} min)`;
      this.log(`⏱️ Programada para iniciar en ${minutos} minutos.`);
      await device.setWarning(msg);
      await this.homey.notifications.createNotification({ excerpt: msg });

      // Programar inicio
      setTimeout(() => {
        this.ejecutarSimulacion(device);
      }, diff);
    } else {
      msg = '🌙 La simulación de hoy ya terminó. Se reanudará mañana.';
      await device.setWarning(msg);
      await this.homey.notifications.createNotification({ excerpt: msg });
    }

  } catch (err) {
    this.error('Error al iniciar simulación:', err);
    const msg = `❌ Error: ${err.message}`;
    await device.setWarning(msg);
    await this.homey.notifications.createNotification({ excerpt: msg });
  }
}

async detenerSimulacionDesdeDevice(device) {
  try {
    this.log(`🧯 [${device.getName()}] → Solicitando detener simulación...`);

    // Obtener horas de sol
    const sun = await this.getSunTimes();
    if (!sun) throw new Error('No se pudieron obtener horarios solares.');

    const rango = this.calcularRangoSimulacion(sun.sunriseUTC, sun.sunsetUTC);
    if (!rango) throw new Error('No se pudo calcular el rango de simulación.');

    const now = new Date();
    const tz = this.systemInfo?.timezone ?? 'America/Argentina/Buenos_Aires';
    const fmt = new Intl.DateTimeFormat('es-AR', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    // Si todavía no llegó el amanecer → programar apagado para endTime
    if (now < rango.endTime) {
      const diff = rango.endTime - now;
      const msg = `🕓 La simulación se detendrá automáticamente a las ${fmt.format(rango.endTime)}.`;
      this.log(msg);
      await device.setWarning(msg);
      await this.homey.notifications.createNotification({ excerpt: msg });

      // Si había un timer previo, lo reemplazamos
      if (this.simulationTimer) clearTimeout(this.simulationTimer);
      this.simulationTimer = setTimeout(() => {
        this._finalizarSimulacion(device);
      }, diff);

    } else {
      // Ya pasó el amanecer → apagar ya
      await this._finalizarSimulacion(device);
    }

  } catch (err) {
    this.error('Error al detener simulación:', err);
    const msg = `❌ Error al detener simulación: ${err.message}`;
    await device.setWarning(msg);
  }
}

// 🔚 Función auxiliar interna
async _finalizarSimulacion(device) {
  this.log(`🌅 [${device.getName()}] → Simulación finalizada.`);
  await device.setWarning('🌅 Simulación finalizada.');
  await this.homey.notifications.createNotification({
    excerpt: '🌅 Simulación finalizada.'
  });

  if (this.simulationTimer) {
    clearTimeout(this.simulationTimer);
    this.simulationTimer = null;
  }
}


// Placeholder de la simulación real
async ejecutarSimulacion(device) {
  try {
    this.log(`🎯 [${device.getName()}] Ejecutando simulación (placeholder)...`);
    await device.setWarning('🎬 Simulación ejecutándose...');
    await this.homey.notifications.createNotification({
      excerpt: '🎬 Simulación iniciada (placeholder, sin acciones).'
    });

    // ⚠️ Futuro:
    // - recorrer this.simulatorData
    // - decidir qué luces prender/apagar
    // - aplicar random_start_delay_minutes, on_duration, coverage, etc.

  } catch (err) {
    this.error('Error en ejecutarSimulacion:', err);
    await device.setWarning(`❌ Error: ${err.message}`);
  }
}





  




};
