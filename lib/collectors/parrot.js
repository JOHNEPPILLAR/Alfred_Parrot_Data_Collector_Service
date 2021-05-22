/**
 * Import external libraries
 */
const noble = require('@abandonware/noble');
const debug = require('debug')('Parrot:DataCollector');

const UUID_SERVICE_BATTERY = '180f';
const UUID_CHARACTERISTIC_BATTERY_LEVEL = '2a19';

const UUID_SERVICE_LIVE_SERVICE = '39e1fa0084a811e2afba0002a5d5c51b';
const UUID_CHARACTERISTIC_SOIL_MOISTURE = '39e1fa0984a811e2afba0002a5d5c51b';
const UUID_CHARACTERISTIC_AIR_TEMPRATURE = '39e1fa0a84a811e2afba0002a5d5c51b';
const UUID_CHARACTERISTIC_SUNLIGHT = '39e1fa0b84a811e2afba0002a5d5c51b';
const UUID_CHARACTERISTIC_FERTILISER = '39e1fa0284a811e2afba0002a5d5c51b';

const deviceScanIntival = 30 * 60 * 1000; // 30 minutes
const processPeripheralsIntival = 20 * 60 * 1000; // 20 minutes
const deviceTimeoutValue = 1 * 60 * 1000; // 1 minute

let scanRunning = false;
let scanCounter = 0;
let deviceTimeout;

/**
 * Save data to data store
 */
async function saveDeviceData(device) {
  let dbConnection;

  debug(`Saving data: ${device.location} - ${device.plant} (${device.device})`);

  try {
    debug('Connect to DB');
    dbConnection = await this._connectToDB();

    debug(`Insert data`);
    const results = await dbConnection
      .db(this.namespace)
      .collection(this.namespace)
      .insertOne(device);

    if (results.insertedCount === 1)
      this.logger.info(
        `Saved data: ${device.location} - ${device.plant} (${device.device})`,
      );
    else
      this.logger.error(
        `${this._traceStack()} - Failed to save data: ${device.location} - ${
          device.plant
        } (${device.device})`,
      );
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  } finally {
    try {
      debug(`Close DB connection`);
      await dbConnection.close();
    } catch (err) {
      debug('Not able to close DB');
    }
  }
}

/**
 * Stop bluetooth device scan
 */
async function stopScanning(resetScanCounter) {
  debug(`Stopping scan`);
  await noble.stopScanningAsync();
  scanRunning = false;
  if (resetScanCounter) scanCounter = 0;
}

/**
 * Start bluetooth device scan
 */
async function startScanning() {
  debug(`Start peripheral discovery`);
  scanRunning = true;
  scanCounter += 1;
  await noble.startScanningAsync(['39e1fa0084a811e2afba0002a5d5c51b'], false);

  setTimeout(async () => {
    if (!scanRunning) return;
    debug(`Peripheral discovery timeout, stopping discovery`);
    await stopScanning.call(this, false);

    const missingDevices = this.devices.filter(
      (d) => typeof d.peripheral === 'undefined',
    );

    let message = `Not able to find: `;
    // eslint-disable-next-line no-restricted-syntax
    for (const md of missingDevices) {
      message += `${md.location} - ${md.plant} (${md.device}) ${
        missingDevices.length === 0 ? ',' : ''
      }`;
    }
    this.logger.error(message);

    if (scanCounter === 3) {
      scanCounter = 0; // Reset counter
      this.logger.error(
        `${this._traceStack()} - Max discovery retry hit. Processing found peripheral(s)`,
      );

      // eslint-disable-next-line no-use-before-define
      await processPeripherals.call(this);
      return;
    }

    debug(`Re-scanning in 30 seconds`);
    setTimeout(async () => {
      startScanning.call(this);
    }, 30 * 1000); // 30 second wait before re-scan for missing devices
  }, deviceTimeoutValue);
}

/**
 * Timeout device
 */
function timeOutDevice(peripheral) {
  let errMessage;
  const promise = new Promise((resolve, reject) => {
    deviceTimeout = setTimeout(() => {
      errMessage = `Peripheral connection/processing timeout: ${peripheral.location} - ${peripheral.plant} (${peripheral.device})`;
      const objIndex = this.devices.findIndex(
        (d) => d.device === peripheral.device,
      );
      this.devices[objIndex].connectionErrors += 1;
      if (this.devices[objIndex].connectionErrors === 2) {
        errMessage = `Max connection/processing error retry hit. Device needs manual reset: ${peripheral.location} - ${peripheral.plant} (${peripheral.device})`;
        delete this.devices[objIndex].peripheral;
      }
      reject(new Error(errMessage));
    }, deviceTimeoutValue);
  });
  return promise;
}

/**
 * Process device
 */
async function processDevice(peripheral) {
  try {
    const sensorJSON = {
      time: new Date(),
      device: peripheral.device,
      location: peripheral.location || '',
      plant: peripheral.plant || '',
      thresholdMoisture: peripheral.thresholdMoisture || 0,
      thresholdFertilizer: peripheral.thresholdFertilizer || 0,
    };

    debug(
      `Connect to peripheral: ${peripheral.location} - ${peripheral.plant} (${peripheral.device})`,
    );
    await peripheral.peripheral.connectAsync();

    debug(
      `Getting services and characteristics from peripheral: ${peripheral.location} - ${peripheral.plant} (${peripheral.device})`,
    );
    const servicesAndCharacteristics = await peripheral.peripheral.discoverAllServicesAndCharacteristicsAsync();

    // Current battery reading
    debug(
      `Getting battery data from: ${peripheral.location} - ${peripheral.plant} (${peripheral.device})`,
    );

    const batteryServices = servicesAndCharacteristics.services.find(
      (entry) => entry.uuid === UUID_SERVICE_BATTERY,
    );
    if (!batteryServices) {
      debug('No battery services found');
    } else {
      const batteryCharacteristic = batteryServices.characteristics.find(
        (entry) => entry.uuid === UUID_CHARACTERISTIC_BATTERY_LEVEL,
      );

      if (!batteryCharacteristic) {
        debug('No battery characteristic found');
      } else {
        const rawValue = await batteryCharacteristic.readAsync();
        sensorJSON.battery = rawValue.readUInt8(0);
      }
    }

    // Get live sensor readings
    debug(
      `Getting live sensor data from: ${peripheral.location} - ${peripheral.plant} (${peripheral.device})`,
    );
    const liveServices = servicesAndCharacteristics.services.find(
      (entry) => entry.uuid === UUID_SERVICE_LIVE_SERVICE,
    );
    if (!liveServices) {
      debug('No live services found');
    } else {
      // Get soil moisture sensor readings
      debug(
        `Getting soil moisture sensor data from: ${peripheral.location} - ${peripheral.plant} (${peripheral.device})`,
      );

      const moistureCharacteristic = liveServices.characteristics.find(
        (entry) => entry.uuid === UUID_CHARACTERISTIC_SOIL_MOISTURE,
      );

      if (!moistureCharacteristic) {
        debug('No moisture characteristic found');
      } else {
        const moistureData = await moistureCharacteristic.readAsync();
        const rawValue = moistureData.readFloatLE(0);
        sensorJSON.moisture = rawValue;
      }

      // Get air temperature sensor readings
      debug(
        `Getting soil temperature sensor data from: ${peripheral.location} - ${peripheral.plant} (${peripheral.device})`,
      );

      const temperatureCharacteristic = liveServices.characteristics.find(
        (entry) => entry.uuid === UUID_CHARACTERISTIC_AIR_TEMPRATURE,
      );

      if (!temperatureCharacteristic) {
        debug('No temperature characteristic found');
      } else {
        const temperatureData = await temperatureCharacteristic.readAsync();
        const rawValue = temperatureData.readFloatLE(0);
        sensorJSON.temperature = rawValue;
      }

      // Get sunlight sensor readings
      debug(
        `Getting sunlight sensor data from: ${peripheral.location} - ${peripheral.plant} (${peripheral.device})`,
      );

      const sunlightCharacteristic = liveServices.characteristics.find(
        (entry) => entry.uuid === UUID_CHARACTERISTIC_SUNLIGHT,
      );

      if (!sunlightCharacteristic) {
        debug('No sunlight characteristic found');
      } else {
        const sunlightData = await sunlightCharacteristic.readAsync();
        const rawValue = sunlightData.readFloatLE(0);
        const adjustementFactor = 4659.293;
        const lowerLuxThreshold = 500.0;

        let lux = rawValue * adjustementFactor;
        if (lux < lowerLuxThreshold) {
          lux = 0;
        }

        sensorJSON.lux = lux;
      }

      // Get fertiliser sensor readings
      debug(
        `Getting fertiliser sensor data from: ${peripheral.location} - ${peripheral.plant} (${peripheral.device})`,
      );

      const fertiliserCharacteristic = liveServices.characteristics.find(
        (entry) => entry.uuid === UUID_CHARACTERISTIC_FERTILISER,
      );

      if (!fertiliserCharacteristic) {
        debug('No fertiliser characteristic found');
      } else {
        const fertiliserData = await fertiliserCharacteristic.readAsync();
        // sensor output (no soil: 0) - (max observed: 1771) wich maps to 0 - 10 (mS/cm)
        // divide by 177,1 to 10 (mS/cm)
        // divide by 1,771 to 1 (uS/cm)
        const rawValue = fertiliserData.readUInt16LE();
        sensorJSON.fertiliser = rawValue;
      }
    }

    debug(`Peripheral (${peripheral.device}) - ${JSON.stringify(sensorJSON)}`);

    debug(
      `Disconnect peripheral: ${peripheral.location} - ${peripheral.plant} (${peripheral.device})`,
    );
    await peripheral.peripheral.disconnectAsync();

    clearTimeout(deviceTimeout);
    await saveDeviceData.call(this, sensorJSON); // Save the device data
  } catch (err) {
    clearTimeout(deviceTimeout);
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  }
  return true;
}

/**
 * Process peripherals array
 */
async function processPeripherals() {
  const devicesToProcess = this.devices.filter(
    (d) => typeof d.peripheral !== 'undefined',
  );

  // If no peripherals assigned to devices, exit
  if (devicesToProcess.length === 0) {
    debug(`No peripheral(s) to process`);
    return;
  }

  debug(`Geting data from peripheral(s)`);

  // eslint-disable-next-line no-restricted-syntax
  for await (const peripheral of devicesToProcess) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await Promise.race([
        processDevice.call(this, peripheral),
        timeOutDevice.call(this, peripheral),
      ]).catch((err) => {
        this.logger.error(`${this._traceStack()} - ${err.message}`);
      });
    } catch (err) {
      this.logger.error(`${this._traceStack()} - ${err.message}`);
    }
  }
}

/**
 * Discover devices
 */
async function discoverDevices() {
  noble.on('stateChange', async (state) => {
    if (state === 'poweredOn') {
      startScanning.call(this);
    } else {
      stopScanning.call(this, true);
    }
  });

  noble.on('discover', async (peripheral) => {
    //
    //
    console.log(peripheral);
    //
    //

    const deviceAddress = peripheral.address;
    const currentDevice = this.devices.filter(
      (d) => d.device === deviceAddress,
    );

    // Check if peripheral is not registed for processing
    if (currentDevice.length === 0) {
      this.logger.info(
        `Found device not assigned to garden: Addr(${peripheral.address}), id(${peripheral.id})`,
      );
      return;
    }

    // Check if peripheral already assigned
    if (typeof currentDevice[0].peripheral !== 'undefined') {
      debug(
        `Existing device found: ${currentDevice[0].location} - ${currentDevice[0].plant} (${deviceAddress})`,
      );
      return;
    }

    // Find index of device in memory
    const objIndex = this.devices.findIndex((d) => d.device === deviceAddress);

    // Assign peripheral to device
    this.logger.info(
      `Found peripheral: ${this.devices[objIndex].location} - ${this.devices[objIndex].plant} (${deviceAddress})`,
    );
    this.devices[objIndex].peripheral = peripheral;

    // Check if found all peripherals
    const foundDevices = this.devices.filter(
      (d) => typeof d.peripheral !== 'undefined',
    );
    if (foundDevices.length === this.devices.length) {
      this.logger.info(`Found all devices`);
      stopScanning.call(this, true);
      processPeripherals.call(this);
    }
  });

  return true;
}

/**
 * Get devices assigned to the zone
 */
async function getDevices() {
  let dbConnection;
  this.devices = [];

  try {
    dbConnection = await this._connectToDB();
    debug(`Query DB`);
    const query = { active: true };
    this.devices = await dbConnection
      .db(this.namespace)
      .collection('devices')
      .find(query)
      .toArray();

    if (this.devices.length === 0) {
      this.logger.error(`${this._traceStack()} - No devices assigned`);
      return false;
    }

    this.logger.info(
      `${this.devices.length} device(s) to discover and process`,
    );
  } catch (err) {
    this.logger.error(`${this._traceStack()} - ${err.message}`);
  } finally {
    try {
      debug(`Close DB connection`);
      await dbConnection.close();
    } catch (err) {
      debug('Not able to close DB');
    }
  }
  return true;
}

/**
 * Get and process devices
 */
async function _processDevices() {
  if (await getDevices.call(this)) {
    await discoverDevices.call(this);
    this.scanIntival = setTimeout(() => {
      startScanning.call(this);
    }, deviceScanIntival);
    this.processPeripheralsIntival = setInterval(() => {
      processPeripherals.call(this);
    }, processPeripheralsIntival);
  } else {
    this.logger.info('No devices to process');
  }
}

module.exports = {
  _processDevices,
};
