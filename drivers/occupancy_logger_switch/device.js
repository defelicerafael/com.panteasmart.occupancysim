'use strict';

const Homey = require('homey');

module.exports = class OccupancyLoggerSwitchDevice extends Homey.Device {
  async onInit() {
    this.registerCapabilityListener('onoff', async (value) => {
      this.log('Switch changed to:', value);
      return true;
    });
  }
};
