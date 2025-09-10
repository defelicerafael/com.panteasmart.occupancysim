'use strict';

const { HomeyAPI } = require('homey-api');

module.exports = {


  async getDevices({ homey }) {
    try {
      // Inicializar HomeyAPI si aún no está inicializada
      if (!homey.app.homeyApi) {
        //console.log('Inicializando HomeyAPI...');
        homey.app.homeyApi = await homey.api.getApiApp({ id: homey.app.manifest.id });
        //console.log('HomeyAPI inicializada correctamente');
      }

      // Obtener dispositivos
      //console.log('Obteniendo dispositivos desde HomeyAPI...');
      const devices = await homey.app.homeyApi.devices.getDevices();

      // Validar respuesta
      if (!devices || typeof devices !== 'object') {
        throw new Error('Respuesta inválida: La lista de dispositivos no es válida');
      }

      // Formatear la lista de dispositivos
      //console.log('Dispositivos obtenidos correctamente');
      return Object.values(devices).map(device => ({
        id: device.id,
        name: device.name,
        type: device.class,
        capabilities: device.capabilities,
      }));
    } catch (error) {
      console.error('Error al obtener dispositivos:', error.message);
      console.error('Detalles del error:', error.stack);
      throw new Error('No se pudieron obtener los dispositivos. Revisa los logs para más detalles.');
    }
  },


  // TRAE LOS DEVICES DE UN DEVICE, SI LE DAS SU NOMBRE...
  async getDeviceCapabilities({ homey, query }) {
    homey.log(query);
    try {
      const deviceName = query.deviceName;
      if (!deviceName) {
        throw new Error('El parámetro "deviceName" es obligatorio');
      }
  
      //console.log('Parámetro deviceName recibido:', deviceName);
  
      if (!homey.app.homeyApi) {
        //console.log('Inicializando HomeyAPI...');
        homey.app.homeyApi = await homey.api.getApiApp({ id: homey.app.manifest.id });
        //console.log('HomeyAPI inicializada correctamente');
      }
  
      //console.log('Obteniendo dispositivos desde HomeyAPI...');
      const devices = await homey.app.homeyApi.devices.getDevices();
  
      //console.log('Dispositivos obtenidos:', devices);
  
      if (!devices || typeof devices !== 'object') {
        throw new Error('Respuesta inválida: La lista de dispositivos no es válida');
      }
  
      //console.log(`Buscando dispositivo con nombre: "${deviceName}"`);
      const device = Object.values(devices).find(d => d.name.toLowerCase() === deviceName.toLowerCase());
  
      if (!device) {
        throw new Error(`Dispositivo con nombre "${deviceName}" no encontrado`);
      }
  
     //console.log(`Capacidades del dispositivo "${deviceName}":`, device.capabilities);
      return {
        id: device.id,
        name: device.name,
        capabilities: device.capabilities,
      };
    } catch (error) {
      console.error('Error al obtener capacidades del dispositivo:', error.message);
      console.error('Detalles del error:', error.stack);
      throw new Error('No se pudieron obtener las capacidades del dispositivo. Revisa los logs para más detalles.');
    }
  },

  async getCommonDeviceCapabilities({ homey, query }) {
    try {
      const deviceNamesParam = query.deviceNames;
  
      if (!deviceNamesParam) {
        throw new Error('El parámetro "deviceNames" es obligatorio.');
      }
  
      // Convertir el string JSON en un array
      const deviceNames = JSON.parse(deviceNamesParam);
  
      if (!Array.isArray(deviceNames) || deviceNames.length === 0) {
        throw new Error('El parámetro "deviceNames" debe ser un array con al menos un nombre.');
      }
  
      //console.log('Nombres de dispositivos recibidos:', deviceNames);
  
      // Inicializar HomeyAPI si no está inicializada
      if (!homey.app.homeyApi) {
        //console.log('Inicializando HomeyAPI...');
        homey.app.homeyApi = await homey.api.getApiApp({ id: homey.app.manifest.id });
        //console.log('HomeyAPI inicializada correctamente');
      }
  
      //console.log('Obteniendo dispositivos desde HomeyAPI...');
      const devices = await homey.app.homeyApi.devices.getDevices();
  
      if (!devices || typeof devices !== 'object') {
        throw new Error('Respuesta inválida: La lista de dispositivos no es válida.');
      }
  
      // Filtrar dispositivos que coincidan con los nombres proporcionados
      const matchingDevices = deviceNames.map(name => {
        const device = Object.values(devices).find(d => d.name.toLowerCase() === name.toLowerCase());
        if (!device) {
          console.warn(`Dispositivo con nombre "${name}" no encontrado.`);
          return null;
        }
        return device;
      }).filter(device => device !== null);
  
      if (matchingDevices.length === 0) {
        throw new Error('Ninguno de los dispositivos especificados fue encontrado.');
      }
  
      //console.log('Dispositivos coincidentes:', matchingDevices);
  
      // Obtener las capacidades comunes
      const commonCapabilities = matchingDevices.reduce((common, device) => {
        if (!device.capabilities) {
          console.warn(`El dispositivo "${device.name}" no tiene capacidades definidas.`);
          return common;
        }
        return common.filter(capability => device.capabilities.includes(capability));
      }, matchingDevices[0].capabilities || []);
  
      //console.log('Capacidades comunes:', commonCapabilities);
  
      return {
        deviceCount: matchingDevices.length,
        devices: matchingDevices.map(device => ({
          id: device.id,
          name: device.name,
          capabilities: device.capabilities,
        })),
        commonCapabilities,
      };
    } catch (error) {
      console.error('Error al obtener capacidades comunes:', error.message);
      console.error('Detalles del error:', error.stack);
      throw new Error('No se pudieron obtener las capacidades comunes de los dispositivos. Revisa los logs para más detalles.');
    }
  },


  async refresh()
  {
    devices = await Homey.devices.getDevices();
    zones = await Homey.zones.getZones();
    systemInfo = await Homey.system.getInfo();
  },


  async getDevicesWithOnOff({ homey }) {
    //console.log("llegué");
    try {
      // Inicializar la HomeyAPI si no está inicializada
      if (!homey.app.homeyApi) {
        homey.app.homeyApi = await homey.api.getApiApp({ id: homey.app.manifest.id });
      }
  
      // Obtener todos los dispositivos
      const devicesMap = await homey.app.homeyApi.devices.getDevices();
      if (!devicesMap || typeof devicesMap !== 'object') {
        throw new Error('Respuesta inválida: La lista de dispositivos no es válida');
      }
  
      // Convertir a array y filtrar solo los que tengan la capability "onoff"
      const filteredDevices = Object.values(devicesMap)
        .filter(device => device.capabilities?.includes('onoff'))
        .map(device => ({
          id: device.id,
          name: device.name,
          type: device.class,
          capabilities: device.capabilities,
          zone: device.zone,
          available: device.available,
        }));
  
      return filteredDevices;
    } catch (error) {
      console.error('Error al obtener dispositivos:', error.message);
      console.error('Detalles del error:', error.stack);
      throw new Error('No se pudieron obtener los dispositivos con onoff. Revisa los logs para más detalles.');
    }
  },
  
  async getDevicesWithCapabilities({ homey, query }) {
    console.log("Obteniendo dispositivos con capabilities:", query.capabilities);
  
    // Validación básica del input
    const capabilitiesArray = Array.isArray(query.capabilities)
      ? query.capabilities
      : typeof query.capabilities === 'string'
      ? [query.capabilities]
      : [];
  
    try {
      // Inicializar la API de Homey si no está aún
      if (!homey.app.homeyApi) {
        homey.app.homeyApi = await homey.api.getApiApp({ id: homey.app.manifest.id });
      }
  
      // Obtener todos los dispositivos
      const devicesMap = await homey.app.homeyApi.devices.getDevices();
      if (!devicesMap || typeof devicesMap !== 'object') {
        throw new Error('Respuesta inválida: La lista de dispositivos no es válida');
      }
  
      // Filtrar dispositivos que tengan todas las capabilities pedidas
      const filteredDevices = Object.values(devicesMap)
        .filter(device => {
          if (!device.capabilities) return false;
          return capabilitiesArray.some(cap => device.capabilities.includes(cap));
        })
        .map(device => ({
          id: device.id,
          name: device.name,
          type: device.class,
          capabilities: device.capabilities,
          zone: device.zone,
          available: device.available,
        }));
  
      return filteredDevices;
  
    } catch (error) {
      console.error('Error al obtener dispositivos:', error.message);
      console.error('Detalles del error:', error.stack);
      throw new Error('No se pudieron obtener los dispositivos. Revisa los logs.');
    }
  },
  
  


  async getSettings({ homey }) {
    try {
      homey.app.log('Entramos a getSettings');

      let settings = await homey.settings.get('settings');
      if (!settings) {
        homey.app.log('No se encontraron configuraciones, usando valores por defecto');
        settings = this.config.settings;
        await homey.settings.set('settings', settings);
      }

      const apiUrl = await homey.api.getLocalUrl();
      homey.app.log('API URL de salida:', apiUrl);

      return {
        message: 'Settings retrieved successfully',
        settings: settings,
        apiUrl: apiUrl,
      };
    } catch (error) {
      homey.app.log('Error retrieving settings:', error);
      return { error: error.message };
    }
  },

  async setSettings({ homey, body }) {
    try {
      if (!body || !body.settings) {
        // Si no hay settings en el cuerpo de la solicitud, reiniciamos a un objeto vacío
        await homey.settings.set('settings', {});
        //homey.app.log('Configuraciones reiniciadas a un objeto vacío.');
        
        return {
          message: 'Settings cleared successfully',
          settings: {},
        };
      }
  
      // Guardar configuraciones proporcionadas
      await homey.settings.set('settings', body.settings);
      const savedSettings = await homey.settings.get('settings');
      //homey.app.log('Configuraciones guardadas exitosamente:', savedSettings);
  
      return {
        message: 'Settings updated successfully',
        settings: savedSettings,
      };
    } catch (error) {
      //homey.app.log('Error updating settings:', error);
      return { error: error.message };
    }
  },

  async getUserInfo({ homey }) {
    
    if (!homey.app.homeyApi) {
     // console.log('Inicializando HomeyAPI...');
      homey.app.homeyApi = await homey.api.getApiApp({ id: homey.app.manifest.id });
      //console.log('HomeyAPI inicializada correctamente');
    }

    //console.log('Obteniendo usuario desde HomeyAPI...');
    
    try {
      //console.log('Obteniendo información del usuario...');
  
      // Obtener la información del usuario actual
      const user = await homey.app.homeyApi.users.getUserMe();
  
      if (!user) {
        throw new Error('No se pudo obtener la información del usuario.');
      }
  
      //console.log('Información del usuario:', user);
  
      return {
        id_homey: user.id,
        name: user.name,
        uri: user.uri || 'No disponible', // El email no suele estar disponible en la API de Homey
        athomId: user.athomId,
        properties: user.properties,
      };
    } catch (error) {
      //console.error('Error obteniendo usuario:', error.message);
      return { error: 'No se pudo obtener la información del usuario.' };
    }
  },

  async getZones({ homey }) {
    try {
      // Inicializar HomeyAPI si aún no está inicializada
      if (!homey.app.homeyApi) {
        homey.app.homeyApi = await homey.api.getApiApp({ id: homey.app.manifest.id });
      }

      // Obtener las zonas
      const zones = await homey.app.homeyApi.zones.getZones();

      // Validar respuesta
      if (!zones || typeof zones !== 'object') {
        throw new Error('Respuesta inválida: La lista de zonas no es válida');
      }

      // Formatear las zonas en un array
      const formattedZones = Object.values(zones).map(zone => ({
        id: zone.id,
        name: zone.name,
        parent: zone.parent, // ID de la zona padre, si existe
        children: zone.children, // IDs de las zonas hijas, si existen
      }));

      return formattedZones;
    } catch (error) {
      console.error('Error al obtener zonas:', error.message);
      console.error('Detalles del error:', error.stack);
      throw new Error('No se pudieron obtener las zonas. Revisa los logs para más detalles.');
    }
  },

}