const Homey = require("homey");

class OccupancyLoggerSwitchDriver extends Homey.Driver {
  // this method is called when the app is started and the Driver is inited
  async onInit() {
    this.log('OccupancyLoggerSwitchDriver has been initialized');
  }

  async onPairListDevices() {
    return [
      {
        name: "Occupancy Logger Switch",
        data: { id: "occupancy_logger_switch" },
        settings: {}
      }
    ];
  }
}

module.exports = OccupancyLoggerSwitchDriver;