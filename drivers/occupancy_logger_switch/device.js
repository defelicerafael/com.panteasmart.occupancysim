'use strict';

const Homey = require('homey');

module.exports = class OccupancyLoggerSwitchDevice extends Homey.Device {
  async onInit() {
    // Listener del botón principal (logger)
    this.registerCapabilityListener('onoff', async (value) => {
      this.log('Switch changed to:', value);
      return true;
    });

    // Listener del botón de simulación
    this.registerCapabilityListener('onoff_simulator', async (value) => {
      this.log('🧠 Simulación:', value);
      if (value) {
        await this.homey.app.iniciarSimulacionDesdeDevice(this);
      } else {
        await this.homey.app.detenerSimulacionDesdeDevice(this);
      }
      return true;
    });
  }

  
};
