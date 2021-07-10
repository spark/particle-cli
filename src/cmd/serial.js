const os = require('os');
const fs = require('fs');
const _ = require('lodash');
const path = require('path');
const chalk = require('chalk');
const VError = require('verror');
const inquirer = require('inquirer');
const prompt = require('inquirer').prompt;
const wifiScan = require('node-wifiscanner2').scan;
const SerialPort = require('../lib/require-optional')('serialport');
const log = require('../lib/log');
const specs = require('../lib/deviceSpecs');
const ApiClient = require('../lib/api-client');
const settings = require('../../settings');
const DescribeParser = require('binary-version-reader').HalDescribeParser;
const YModem = require('../lib/ymodem');
const SerialBatchParser = require('../lib/serial-batch-parser');
const SerialTrigger = require('../lib/serial-trigger');
const spinnerMixin = require('../lib/spinner-mixin');
const ensureError = require('../lib/utilities').ensureError;

// TODO: DRY this up somehow
// The categories of output will be handled via the log class, and similar for protip.
const cmd = path.basename(process.argv[1]);
const arrow = chalk.green('>');
const alert = chalk.yellow('!');
const timeoutError = 'Serial timed out';

function protip(){
	const args = Array.prototype.slice.call(arguments);
	args.unshift(chalk.cyan('!'), chalk.bold.white('PROTIP:'));
	console.log.apply(null, args);
}


// An LTE device may take up to 18 seconds to power up the modem
const MODULE_INFO_COMMAND_TIMEOUT = 20000;
const IDENTIFY_COMMAND_TIMEOUT = 20000;

const SERIAL_PORT_DEFAULTS = {
	baudRate: 9600,
	autoOpen: false
};

module.exports = class SerialCommand {
	constructor(){
		spinnerMixin(this);
	}

	findDevices(){
		return SerialPort.list()
			.then(ports => {
				const devices = [];

				ports.forEach((port) => {
					// manufacturer value
					// Mac - Spark devices
					// Devices on old driver - Spark Core, Photon
					// Devices on new driver - Particle IO (https://github.com/spark/firmware/pull/447)
					// Windows only contains the pnpId field

					let device;
					const serialDeviceSpec = _.find(specs, (deviceSpec) => {
						if (!deviceSpec.serial){
							return false;
						}
						const vid = deviceSpec.serial.vid;
						const pid = deviceSpec.serial.pid;

						const usbMatches = (port.vendorId === vid.toLowerCase() && port.productId === pid.toLowerCase());
						const pnpMatches = !!(port.pnpId && (port.pnpId.indexOf('VID_' + vid.toUpperCase()) >= 0) && (port.pnpId.indexOf('PID_' + pid.toUpperCase()) >= 0));

						return !!(usbMatches || pnpMatches);

					});

					if (serialDeviceSpec){
						device = {
							port: port.path,
							type: serialDeviceSpec.productName,
							deviceId: serialDeviceSpec.serial.deviceId && serialDeviceSpec.serial.deviceId(port.serialNumber || port.pnpId),
							specs: serialDeviceSpec
						};
					}

					// Populate the Device ID based on the ports serial number:
					if (device && port.serialNumber && typeof device.deviceId == 'undefined') {
						device.deviceId = port.serialNumber;
					}

					const matchesManufacturer = port.manufacturer && (port.manufacturer.indexOf('Particle') >= 0 || port.manufacturer.indexOf('Spark') >= 0 || port.manufacturer.indexOf('Photon') >= 0);

					if (!device && matchesManufacturer){
						device = { port: port.path, type: 'Core' };
					}

					if (device){
						devices.push(device);
					}
				});

				//if I didn't find anything, grab any 'ttyACM's
				if (devices.length === 0){
					ports.forEach((port) => {
						//if it doesn't have a manufacturer or pnpId set, but it's a ttyACM port, then lets grab it.
						if (port.path.indexOf('/dev/ttyACM') === 0){
							devices.push({ port: port.path, type: '' });
						} else if (port.path.indexOf('/dev/cuaU') === 0){
							devices.push({ port: port.path, type: '' });
						}
					});
				}

				return devices;
			})
			.catch(err => {
				throw new VError(ensureError(err), 'Error listing serial ports');
			});
	}

	listDevices(){
		return this.findDevices()
			.then(devices => {
				if (devices.length === 0){
					console.log(chalk.bold.white('No devices available via serial'));
					return;
				}

				console.log('Found', chalk.cyan(devices.length), (devices.length > 1 ? 'devices' : 'device'), 'connected via serial:');
				devices.forEach((device) => console.log(`${device.port} - ${device.type} - ${device.deviceId}`));
			});
	}

	monitorPort({ port, follow }){
		let cleaningUp = false;
		let selectedDevice;
		let serialPort;

		const displayError = (err) => {
			if (err){
				console.error('Serial err: ' + err);
				console.error('Serial problems, please reconnect the device.');
			}
		};

		// Called when port closes
		const handleClose = () => {
			console.log(os.EOL);
			if (follow && !cleaningUp){
				console.log(chalk.bold.white('Serial connection closed.  Attempting to reconnect...'));
				return reconnect();
			}
			console.log(chalk.bold.white('Serial connection closed.'));
		};

		// Handle interrupts and close the port gracefully
		const handleInterrupt = (silent) => {
			if (!cleaningUp){
				if (!silent){
					console.log(chalk.bold.red('Caught Interrupt.  Cleaning up.'));
				}
				cleaningUp = true;
				if (serialPort && serialPort.isOpen){
					serialPort.close();
				}
				process.exit(0);
			}
		};

		// Called only when the port opens successfully
		const handleOpen = () => {
			console.log(chalk.bold.white('Serial monitor opened successfully:'));
		};

		const handlePortFn = (device) => {
			if (!device){
				if (follow){
					setTimeout(() => {
						if (cleaningUp){
							return;
						} else {
							this.whatSerialPortDidYouMean(port, true).then(handlePortFn);
						}
					}, settings.serial_follow_delay);
					return;
				} else {
					throw new VError('No serial port identified');
				}
			}

			console.log('Opening serial monitor for com port: "' + device.port + '"');
			selectedDevice = device;
			openPort();
		};

		function openPort(){
			serialPort = new SerialPort(selectedDevice.port, SERIAL_PORT_DEFAULTS);
			serialPort.on('close', handleClose);
			serialPort.on('readable', () => {
				process.stdout.write(serialPort.read().toString());
			});
			serialPort.on('error', displayError);
			serialPort.open((err) => {
				if (err && follow){
					reconnect(selectedDevice);
				} else if (err){
					displayError(err);
				} else {
					handleOpen();
				}
			});
		}

		function reconnect(){
			setTimeout(() => {
				openPort(selectedDevice);
			}, settings.serial_follow_delay);
		}

		process.on('SIGINT', handleInterrupt);
		process.on('SIGQUIT', handleInterrupt);
		process.on('SIGBREAK', handleInterrupt);
		process.on('SIGTERM', handleInterrupt);
		process.on('exit', () => handleInterrupt(true));

		if (follow){
			console.log('Polling for available serial device...');
		}

		return this.whatSerialPortDidYouMean(port, true).then(handlePortFn);
	}

	/**
	 * Check to see if the device is in listening mode, try to get the device ID via serial
	 * @param {Number|String} comPort
	 */
	identifyDevice({ port }){
		let device;
		return this.whatSerialPortDidYouMean(port, true)
			.then(_device => {
				device = _device;
				if (!device){
					throw new VError('No serial port identified');
				}

				return this.askForDeviceID(device);
			})
			.then(data => {
				if (_.isObject(data)){
					console.log();
					console.log('Your device id is', chalk.bold.cyan(data.id));
					if (data.imei){
						console.log('Your IMEI is', chalk.bold.cyan(data.imei));
					}
					if (data.iccid){
						console.log('Your ICCID is', chalk.bold.cyan(data.iccid));
					}
				} else {
					console.log();
					console.log('Your device id is', chalk.bold.cyan(data));
				}

				return this.askForSystemFirmwareVersion(device, 2000)
					.then(version => {
						console.log('Your system firmware version is', chalk.bold.cyan(version));
					})
					.catch(() => {
						console.log('Unable to determine system firmware version');
					});
			})
			.catch((err) => {
				throw new VError(err, 'Could not identify device');
			});
	}

	deviceMac({ port }){
		return this.whatSerialPortDidYouMean(port, true)
			.then(device => {
				if (!device){
					throw new VError('No serial port identified');
				}

				return this.getDeviceMacAddress(device);
			})
			.then(data => {
				console.log();
				console.log('Your device MAC address is', chalk.bold.cyan(data));
			})
			.catch((err) => {
				throw new VError(ensureError(err), 'Could not get MAC address');
			});
	}

	inspectDevice({ port }){
		return this.whatSerialPortDidYouMean(port, true)
			.then(device => {
				if (!device){
					throw new VError('No serial port identified');
				}

				return this.getSystemInformation(device);
			})
			.then((data) => {
				const functionMap = {
					s: 'System',
					u: 'User',
					b: 'Bootloader',
					r: 'Reserved',
					m: 'Monolithic',
					a: 'Radio stack',
					c: 'NCP'
				};
				const locationMap = {
					m: 'main',
					b: 'backup',
					f: 'factory',
					t: 'temp'
				};

				const d = JSON.parse(data);
				const parser = new DescribeParser();
				const modules = parser.getModules(d);

				if (d.p !== undefined){
					const platformName = settings.knownPlatforms[d.p];
					console.log('Platform:', d.p, platformName ? ('- ' + chalk.bold.cyan(platformName)) : '');
				}

				if (modules && modules.length > 0){
					console.log(chalk.underline('Modules'));
					modules.forEach((m) => {
						const func = functionMap[m.func];
						if (!func){
							console.log(`  empty - ${locationMap[m.location]} location, ${m.maxSize} bytes max size`);
							return;
						}

						console.log(`  ${chalk.bold.cyan(func)} module ${chalk.bold('#' + m.name)} - version ${chalk.bold(m.version)}, ${locationMap[m.location]} location, ${m.maxSize} bytes max size`);

						if (m.isUserModule() && m.uuid){
							console.log('    UUID:', m.uuid);
						}

						console.log('    Integrity: %s', m.hasIntegrity() ? chalk.green('PASS') : chalk.red('FAIL'));
						console.log('    Address Range: %s', m.isImageAddressInRange() ? chalk.green('PASS') : chalk.red('FAIL'));
						console.log('    Platform: %s', m.isImagePlatformValid() ? chalk.green('PASS') : chalk.red('FAIL'));
						console.log('    Dependencies: %s', m.areDependenciesValid() ? chalk.green('PASS') : chalk.red('FAIL'));

						if (m.dependencies.length > 0){
							m.dependencies.forEach((dep) => {
								const df = functionMap[dep.func];
								console.log(`      ${df} module #${dep.name} - version ${dep.version}`);
							});
						}
					});
				}
			})
			.catch((err) => {
				throw new VError(ensureError(err), 'Could not get inspect device');
			});
	}

	_promptForListeningMode(){
		console.log(
			chalk.cyan('!'),
			'PROTIP:',
			chalk.white('Hold the'),
			chalk.cyan('SETUP'),
			chalk.white('button on your device until it'),
			chalk.cyan('blinks blue!')
		);

		return prompt([
			{
				type: 'input',
				name: 'listening',
				message: 'Press ' + chalk.bold.cyan('ENTER') + ' when your device is blinking ' + chalk.bold.blue('BLUE')
			}
		]);
	}

	flashDevice(binary, { port, yes }){
		let device;

		return Promise.resolve()
			.then(() => {
				if (!yes){
					return this._promptForListeningMode();
				}
			})
			.then(() => this.whatSerialPortDidYouMean(port, true))
			.then(_device => {
				device = _device;
				if (!device){
					throw new VError('No serial port identified');
				}
				if (device.type === 'Core'){
					throw new VError('Serial flashing is not supported on the Core');
				}

				//only match against knownApp if file is not found
				let stats;
				try {
					stats = fs.statSync(binary);
				} catch (ex){
					// file does not exist
					const specsByProduct = _.keyBy(specs, 'productName');
					const productSpecs = specsByProduct[device.type];
					binary = productSpecs && productSpecs.knownApps[binary];
					if (binary === undefined){
						throw new VError('File does not exist and no known app found');
					} else {
						return;
					}
				}

				if (!stats.isFile()){
					throw new VError('You cannot flash a directory over USB');
				}
			})
			.then(() => {
				const serialPort = new SerialPort(device.port, {
					baudRate: 28800,
					autoOpen: false
				});

				const closePort = () => {
					if (serialPort.isOpen){
						serialPort.close();
					}
					process.exit(0);
				};
				process.on('SIGINT', closePort);
				process.on('SIGTERM', closePort);

				const ymodem = new YModem(serialPort, { debug: true });
				return ymodem.send(binary);
			})
			.then(() => {
				console.log('\nFlash success!');
			})
			.catch(err => {
				throw new VError(ensureError(err), 'Error writing firmware');
			});
	}

	_scanNetworks(){
		return new Promise((resolve, reject) => {
			this.newSpin('Scanning for nearby Wi-Fi networks...').start();

			wifiScan((err, networkList) => {
				this.stopSpin();

				if (err){
					return reject(new VError('Unable to scan for Wi-Fi networks. Do you have permission to do that on this system?'));
				}
				resolve(networkList);
			});
		})
			.then(networkList => {
				// todo - if the prompt is auto answering, then only auto answer once, to prevent
				// never ending loops
				if (networkList.length === 0){
					return prompt([{
						type: 'confirm',
						name: 'rescan',
						message: 'Uh oh, no networks found. Try again?',
						default: true
					}]).then((answers) => {
						if (answers.rescan){
							return this._scanNetworks();
						}
						return [];
					});
				}

				networkList = networkList.filter((ap) => {
					if (!ap){
						return false;
					}

					// channel # > 14 === 5GHz
					if (ap.channel && parseInt(ap.channel, 10) > 14){
						return false;
					}
					return true;
				});

				networkList.sort((a, b) => {
					return a.ssid.toLowerCase().localeCompare(b.ssid.toLowerCase());
				});

				return networkList;
			});
	}

	configureWifi({ port, file, clear }){
		const credentialsFile = file;

		return this.whatSerialPortDidYouMean(port, true)
			.then(device => {
				if (!device){
					throw new VError('No serial port identified');
				}

				if (clear){
					this._clearDeviceWifi(device);
				}

				if (credentialsFile){
					return this._configWifiFromFile(device, credentialsFile);
				} else {
					return this.promptWifiScan(device);
				}
			})
			.catch(err => {
				throw new VError(ensureError(err), 'Error configuring Wi-Fi');
			});
	}

	_clearDeviceWifi(device) {
		if (!device){
			return Promise.reject('No serial port available');
		}

		log.verbose('Attempting to clean Wi-Fi credentials on ' + device.port);

		const self = this;
		let cleanUpFn;
		const promise = new Promise((resolve, reject) => {
			const serialPort = self.serialPort || new SerialPort(device.port, SERIAL_PORT_DEFAULTS);
			const parser = new SerialBatchParser({ timeout: 250 });

			cleanUpFn = () => {
				resetTimeout();
				serialPort.removeListener('close', serialClosedEarly);
				return new Promise((resolve) => {
					serialPort.close(resolve);
				});
			};
			serialPort.pipe(parser);
			serialPort.on('error', (err) => reject(err));
			serialPort.on('close', serialClosedEarly);

			const serialTrigger = new SerialTrigger(serialPort, parser);

			serialTrigger.addTrigger('Awesome. Credentials erased correcly!', () => {
				resetTimeout();
				resolve();
			});

			serialPort.open((err) => {
				if (err){
					return reject(err);
				}

				serialTrigger.start(true);
				serialPort.write('W');
				serialPort.drain();

				// In case device is not in listening mode.
				startTimeout(5000, 'Serial timed out while initially listening to device, please ensure device is in listening mode with particle usb start-listening', 'InitialTimeoutError');
			});

			function serialClosedEarly(){
				reject('Serial port closed early');
			}

			function startTimeout(to, message = timeoutError, name = 'TimeoutError'){
				self._serialTimeout = setTimeout(() => {
					reject(new VError({ name }, message));
				}, to);
			}

			function resetTimeout(){
				clearTimeout(self._serialTimeout);
				self._serialTimeout = null;
			}

		});

		return promise.finally(cleanUpFn);
	}

	_configWifiFromFile(device, filename){
		// TODO (mirande): use util.promisify once node@6 is no longer supported
		return new Promise((resolve, reject) => {
			fs.readFile(filename, 'utf8', (error, data) => {
				if (error){
					return reject(error);
				}
				return resolve(data);
			});
		})
			.then(content => {
				const opts = JSON.parse(content);
				return this.serialWifiConfig(device, opts);
			});
	}

	promptWifiScan(device){
		const question = {
			type: 'confirm',
			name: 'scan',
			message: chalk.bold.white('Should I scan for nearby Wi-Fi networks?'),
			default: true
		};

		return prompt([question])
			.then((ans) => {
				if (ans.scan){
					return this._scanNetworks().then(networks => {
						return this._getWifiInformation(device, networks);
					});
				} else {
					return this._getWifiInformation(device);
				}
			});
	}

	_removePhotonNetworks(ssids){
		return ssids.filter((ap) => {
			if (ap.indexOf('Photon-') === 0){
				return false;
			}
			return true;
		});
	}

	_getWifiInformation(device, networks){
		const rescanLabel = '[rescan networks]';

		networks = networks || [];
		const networkMap = _.keyBy(networks, 'ssid');

		let ssids = _.map(networks, 'ssid');
		ssids = this._removePhotonNetworks(ssids);

		const questions = [
			{
				type: 'list',
				name: 'ap',
				message: chalk.bold.white('Select the Wi-Fi network with which you wish to connect your device:'),
				choices: () => {
					const ns = ssids.slice();
					ns.unshift(new inquirer.Separator());
					ns.unshift(rescanLabel);
					ns.unshift(new inquirer.Separator());

					return ns;
				},
				when: () => {
					return networks.length;
				}
			},
			{
				type: 'confirm',
				name: 'detectSecurity',
				message: chalk.bold.white('Should I try to auto-detect the wireless security type?'),
				when: (answers) => {
					return !!answers.ap && !!networkMap[answers.ap] && !!networkMap[answers.ap].security;
				},
				default: true
			}
		];

		return prompt(questions)
			.then(answers => {
				if (answers.ap === rescanLabel){
					return this._scanNetworks().then(networks => {
						return this._getWifiInformation(device, networks);
					});
				}

				const network = answers.ap;
				const ap = networkMap[network];
				const security = answers.detectSecurity && ap && ap.security;

				if (security){
					console.log(arrow, 'Detected', security, 'security');
				}

				return this.serialWifiConfig(device, { network, security });
			});
	}

	supportsClaimCode(device){
		return this._issueSerialCommand(device, 'c', 500)
			.then((data) => {
				const matches = data.match(/Device claimed: (\w+)/);
				return !!matches;
			})
			.catch((err) => {
				if (err !== timeoutError){
					throw err;
				}
				return false;
			});
	}

	/**
	 * Performs device setup via serial. The device should already be in listening mode.
	 * Setup comprises these steps:
	 * - fetching the claim code from the API
	 * - setting the claim code on the device
	 * - configuring
	 * @param device
	 */
	setup(device){
		const self = this;
		let _deviceID = '';
		const api = new ApiClient();

		function afterClaim(err, dat){
			self.stopSpin();

			if (err){
				// TODO: Graceful recovery here
				// How about retrying the claim code again
				// console.log(arrow, arrow, err);
				if (err.code === 'ENOTFOUND'){
					protip("Your computer couldn't find the cloud...");
				}

				if (!err.code && err.message){
					protip(err.message);
				} else {
					protip('There was a network error while connecting to the cloud...');
					protip('We need an active internet connection to successfully complete setup.');
					protip('Are you currently connected to the internet? Please double-check and try again.');
				}
				return;
			}

			console.log(arrow, 'Obtained magical secure claim code.');
			console.log();

			return self.sendClaimCode(device, dat.claim_code)
				.then(() => {
					console.log('Claim code set. Now setting up Wi-Fi');
					// todo - add additional commands over USB to have the device scan for Wi-Fi
					return self.promptWifiScan(device);
				})
				.then(revived);
		}

		function getClaim(){
			self.newSpin('Obtaining magical secure claim code from the cloud...').start();
			api.getClaimCode()
				.then((response) => {
					afterClaim(null, response);
				}, (error) => {
					afterClaim(error);
				});
		}

		function revived(){
			self.stopSpin();
			self.newSpin("Attempting to verify the Photon's connection to the cloud...").start();

			setTimeout(() => {
				api.listDevices({ silent: true })
					.then((body) => {
						checkDevices(null, body);
					}, (error) => {
						checkDevices(error);
					});
			}, 6000);
		}

		function checkDevices(err, dat){
			self.stopSpin();

			if (err){
				if (err.code === 'ENOTFOUND'){
					// todo - limit the number of retries here.
					console.log(alert, 'Network not ready yet, retrying...');
					console.log();
					return revived(null);
				}
				console.log(alert, 'Unable to verify your Photon\'s connection.');
				console.log(alert, "Please make sure you're connected to the internet.");
				console.log(alert, 'Then try', chalk.bold.cyan(cmd + ' list'), "to verify it's connected.");
				self.exit();
			}

			// self.deviceID -> _deviceID
			const onlinePhoton = _.find(dat, (device) => {
				return (device.id.toUpperCase() === _deviceID.toUpperCase()) && device.connected === true;
			});

			if (onlinePhoton){
				console.log(arrow, 'It looks like your Photon has made it happily to the cloud!');
				console.log();
				namePhoton(onlinePhoton.id);
				return;
			}

			console.log(alert, "It doesn't look like your Photon has made it to the cloud yet.");
			console.log();

			const question = {
				type: 'list',
				name: 'recheck',
				message: 'What would you like to do?',
				choices: [
					{ name: 'Check again to see if the Photon has connected', value: 'recheck' },
					{ name: 'Reconfigure the Wi-Fi settings of the Photon', value: 'reconfigure' }
				]
			};

			prompt([question]).then(recheck);

			function recheck(ans){
				if (ans.recheck === 'recheck'){
					api.listDevices({ silent: true })
						.then((body) => {
							checkDevices(null, body);
						}, (error) => {
							checkDevices(error);
						});
				} else {
					self._promptForListeningMode();
					self.setup(device);
				}
			}
		}

		function namePhoton(deviceId){
			const question = {
				type: 'input',
				name: 'deviceName',
				message: 'What would you like to call your Photon (Enter to skip)?'
			};

			prompt([question])
				.then((ans) => {
					// todo - retrieve existing name of the device?
					const deviceName = ans.deviceName;
					if (deviceName){
						api.renameDevice(deviceId, deviceName)
							.then(() => {
								console.log();
								console.log(arrow, 'Your Photon has been given the name', chalk.bold.cyan(deviceName));
								console.log(arrow, "Congratulations! You've just won the internet!");
								console.log();
								self.exit();
							}, (err) => {
								console.error(alert, 'Error naming your Photon: ', err);
								namePhoton(deviceId);
							});
					} else {
						console.log('Skipping device naming.');
						self.exit();
					}
				});
		}

		return this.askForDeviceID(device)
			.then((deviceID) => {
				_deviceID = deviceID;
				console.log('setting up device', deviceID);
				return getClaim();
			})
			.catch((err) => {
				this.stopSpin();
				throw new VError(ensureError(err), 'Error during setup');
			});
	}

	claimDevice({ port, claimCode }){
		return this.whatSerialPortDidYouMean(port, true)
			.then(device => {
				if (!device){
					throw new VError('No serial port identified');
				}
				return this.sendClaimCode(device, claimCode);
			})
			.then(() => {
				console.log('Claim code set.');
			});
	}

	sendClaimCode(device, claimCode){
		const expectedPrompt = 'Enter 63-digit claim code: ';
		const confirmation = 'Claim code set to: ' + claimCode;
		return this.doSerialInteraction(device, 'C', [
			[expectedPrompt, 2000, (deferred, next) => {
				next(claimCode + '\n');
			}],
			[confirmation, 2000, (deferred, next) => {
				next();
				deferred.resolve();
			}]
		]);
	}

	/**
	 *
	 * @param {Device} device        The device to interact with
	 * @param {String} command      The initial command to send to the device
	 * @param {Array} interactions  an array of interactions. Each interaction is
	 *  an array, with these elements:
	 *  [0] - the prompt text to interact with
	 *  [1] - the timeout to wait for this prompt
	 *  [2] - the callback when the prompt has been received. The callback takes
	 *      these arguments:
	 *          promise: the deferred result (call resolve/reject)
	 *          next: the response callback, should be called with (response) to send a response.
	 *              Response can be undefined
	 * @returns {Promise}
	 */
	doSerialInteraction(device, command, interactions){
		if (!device){
			throw new VError('No serial port identified');
		}

		if (!interactions.length){
			return;
		}

		const self = this;
		let cleanUpFn;
		const promise = new Promise((resolve, reject) => {
			const serialPort = this.serialPort || new SerialPort(device.port, SERIAL_PORT_DEFAULTS);
			const parser = new SerialBatchParser({ timeout: 250 });

			cleanUpFn = () => {
				resetTimeout();
				serialPort.removeListener('close', serialClosedEarly);
				return new Promise((resolve) => serialPort.close(resolve));
			};
			serialPort.pipe(parser);
			serialPort.on('error', (err) => reject(err));
			serialPort.on('close', serialClosedEarly);

			const serialTrigger = new SerialTrigger(serialPort, parser);
			let expectedPrompt = interactions[0][0];
			let callback = interactions[0][2];

			for (let i = 1; i < interactions.length; i++){
				const timeout = interactions[i][1];
				addTrigger(expectedPrompt, timeout, callback);
				expectedPrompt = interactions[i][0];
				callback = interactions[i][2];
			}

			// the last interaction completes without a timeout
			addTrigger(expectedPrompt, undefined, callback);

			serialPort.open((err) => {
				if (err){
					return reject(err);
				}

				serialTrigger.start();

				if (command){
					serialPort.write(command);
					serialPort.drain(next);
				} else {
					next();
				}

				function next(){
					startTimeout(interactions[0][1]);
				}
			});

			function serialClosedEarly(){
				reject('Serial port closed early');
			}

			function startTimeout(to){
				self._serialTimeout = setTimeout(() => reject(timeoutError), to);
			}

			function resetTimeout(){
				clearTimeout(self._serialTimeout);
				self._serialTimeout = null;
			}

			function addTrigger(expectedPrompt, timeout, callback){
				serialTrigger.addTrigger(expectedPrompt, (cb) => {
					resetTimeout();

					callback({ resolve, reject }, (response) => {
						cb(response, timeout ? startTimeout.bind(self, timeout) : undefined);
					});
				});
			}
		});

		return promise.finally(cleanUpFn);
	}

	/**
	 * This is a wrapper function so _serialWifiConfig can return the
	 * true promise state for testing.
	 */
	serialWifiConfig(...args) {
		return this._serialWifiConfig(...args)
			.then(() => {
				console.log('Done! Your device should now restart.');
			}, (err) => {
				if (err && err.message) {
					log.error('Something went wrong:', err.message);
				} else {
					log.error('Something went wrong:', err);
				}
			});
	}

	/* eslint-disable max-statements */
	_serialWifiConfig(device, opts = {}){
		if (!device){
			return Promise.reject('No serial port available');
		}

		log.verbose('Attempting to configure Wi-Fi on ' + device.port);

		let isEnterprise = false;
		const self = this;
		let cleanUpFn;
		const promise = new Promise((resolve, reject) => {
			const serialPort = self.serialPort || new SerialPort(device.port, SERIAL_PORT_DEFAULTS);
			const parser = new SerialBatchParser({ timeout: 250 });

			cleanUpFn = () => {
				resetTimeout();
				serialPort.removeListener('close', serialClosedEarly);
				return new Promise((resolve) => {
					serialPort.close(resolve);
				});
			};
			serialPort.pipe(parser);
			serialPort.on('error', (err) => reject(err));
			serialPort.on('close', serialClosedEarly);

			const serialTrigger = new SerialTrigger(serialPort, parser);

			serialTrigger.addTrigger('SSID:', (cb) => {
				resetTimeout();

				if (opts.network){
					return cb(opts.network + '\n');
				}

				const question = {
					type: 'input',
					name: 'ssid',
					message: 'SSID',
					validate: (input) => {
						if (!input || !input.trim()){
							return 'Please enter a valid SSID';
						} else {
							return true;
						}
					},
					filter: (input) => {
						return input.trim();
					}
				};

				prompt([question])
					.then((ans) => {
						cb(ans.ssid + '\n', startTimeout.bind(self, 5000));
					});
			});

			serialTrigger.addTrigger('Security 0=unsecured, 1=WEP, 2=WPA, 3=WPA2:', parsesecurity.bind(null, false));
			serialTrigger.addTrigger('Security 0=unsecured, 1=WEP, 2=WPA, 3=WPA2, 4=WPA Enterprise, 5=WPA2 Enterprise:', parsesecurity.bind(null, true));

			serialTrigger.addTrigger('Security Cipher 1=AES, 2=TKIP, 3=AES+TKIP:', (cb) => {
				resetTimeout();
				if (opts.security !== undefined){
					let cipherType = 1;
					if (opts.security.indexOf('AES') >= 0 && opts.security.indexOf('TKIP') >= 0){
						cipherType = 3;
					} else if (opts.security.indexOf('TKIP') >= 0){
						cipherType = 2;
					} else if (opts.security.indexOf('AES') >= 0){
						cipherType = 1;
					}

					return cb(cipherType + '\n', startTimeout.bind(self, 5000));
				}

				const question = {
					type: 'list',
					name: 'cipher',
					message: 'Cipher Type',
					choices: [
						{ name: 'AES+TKIP', value: 3 },
						{ name: 'TKIP', value: 2 },
						{ name: 'AES', value: 1 }
					]
				};

				prompt([question])
					.then((ans) => {
						cb(ans.cipher + '\n', startTimeout.bind(self, 5000));
					});
			});

			serialTrigger.addTrigger('EAP Type 0=PEAP/MSCHAPv2, 1=EAP-TLS:', (cb) => {
				resetTimeout();

				isEnterprise = true;

				if (opts.eap !== undefined){
					let eapType = 0;
					if (opts.eap.toLowerCase().indexOf('peap') >= 0){
						eapType = 0;
					} else if (opts.eap.toLowerCase().indexOf('tls')){
						eapType = 1;
					}
					return cb(eapType + '\n', startTimeout.bind(self, 5000));
				}

				const question = {
					type: 'list',
					name: 'eap',
					message: 'EAP Type',
					choices: [
						{ name: 'PEAP/MSCHAPv2', value: 0 },
						{ name: 'EAP-TLS', value: 1 }
					]
				};

				prompt([question])
					.then((ans) => {
						cb(ans.eap + '\n', startTimeout.bind(self, 5000));
					});
			});

			serialTrigger.addTrigger('Username:', (cb) => {
				resetTimeout();

				if (opts.username){
					cb(opts.username + '\n', startTimeout.bind(self, 15000));
				} else {
					const question = {
						type: 'input',
						name: 'username',
						message: 'Username',
						validate: (val) => {
							return !!val;
						}
					};

					prompt([question])
						.then((ans) => {
							cb(ans.username + '\n', startTimeout.bind(self, 15000));
						});
				}
			});

			serialTrigger.addTrigger('Outer identity (optional):', (cb) => {
				resetTimeout();

				if (opts.outer_identity){
					cb(opts.outer_identity.trim + '\n', startTimeout.bind(self, 15000));
				} else {
					const question = {
						type: 'input',
						name: 'outer_identity',
						message: 'Outer identity (optional)'
					};

					prompt([question])
						.then((ans) => {
							cb(ans.outer_identity + '\n', startTimeout.bind(self, 15000));
						});
				}
			});

			serialTrigger.addTrigger('Client certificate in PEM format:', (cb) => {
				resetTimeout();

				if (opts.client_certificate){
					cb(opts.client_certificate.trim() + '\n\n', startTimeout.bind(self, 15000));
				} else {
					const question = {
						type: 'editor',
						name: 'client_certificate',
						message: 'Client certificate in PEM format',
						validate: (val) => {
							return !!val;
						}
					};

					prompt([question])
						.then((ans) => {
							cb(ans.client_certificate.trim() + '\n\n', startTimeout.bind(self, 15000));
						});
				}
			});

			serialTrigger.addTrigger('Private key in PEM format:', (cb) => {
				resetTimeout();

				if (opts.private_key){
					cb(opts.private_key.trim() + '\n\n', startTimeout.bind(self, 15000));
				} else {
					const question = {
						type: 'editor',
						name: 'private_key',
						message: 'Private key in PEM format',
						validate: (val) => {
							return !!val;
						}
					};

					prompt([question])
						.then((ans) => {
							cb(ans.private_key.trim() + '\n\n', startTimeout.bind(self, 15000));
						});
				}
			});

			serialTrigger.addTrigger('Root CA in PEM format (optional):', (cb) => {
				resetTimeout();

				if (opts.root_ca){
					cb(opts.root_ca.trim() + '\n\n', startTimeout.bind(self, 15000));
				} else {
					const questions = [
						{
							type: 'confirm',
							name: 'provide_root_ca',
							message: 'Would you like to provide CA certificate?',
							default: true
						},
						{
							type: 'editor',
							name: 'root_ca',
							message: 'CA certificate in PEM format',
							when: (answers) => {
								return answers.provide_root_ca;
							},
							validate: (val) => {
								return !!val;
							},
							default: ''
						}
					];

					prompt(questions)
						.then((ans) => {
							if (ans.root_ca === undefined){
								ans.root_ca = '';
							}
							cb(ans.root_ca.trim() + '\n\n', startTimeout.bind(self, 15000));
						});
				}
			});

			serialTrigger.addTrigger('Password:', (cb) => {
				resetTimeout();
				// Skip password prompt as appropriate
				if (opts.password){
					cb(opts.password + '\n', startTimeout.bind(self, 15000));
				} else {
					const question = {
						type: 'input',
						name: 'password',
						message: !isEnterprise ? 'Wi-Fi Password' : 'Password',
						validate: (val) => {
							return !!val;
						}
					};

					prompt([question])
						.then((ans) => {
							cb(ans.password + '\n', startTimeout.bind(self, 15000));
						});
				}
			});

			serialTrigger.addTrigger('Spark <3 you!', () => {
				resetTimeout();
				resolve();
			});

			serialTrigger.addTrigger('Particle <3 you!', () => {
				resetTimeout();
				resolve();
			});

			serialPort.open((err) => {
				if (err){
					return reject(err);
				}

				serialTrigger.start(true);
				serialPort.write('w');
				serialPort.drain();

				// In case device is not in listening mode.
				startTimeout(5000, 'Serial timed out while initially listening to device, please ensure device is in listening mode with particle usb start-listening', 'InitialTimeoutError');
			});

			function serialClosedEarly(){
				reject('Serial port closed early');
			}

			function startTimeout(to, message = timeoutError, name = 'TimeoutError'){
				self._serialTimeout = setTimeout(() => {
					reject(new VError({ name }, message));
				}, to);
			}

			function resetTimeout(){
				clearTimeout(self._serialTimeout);
				self._serialTimeout = null;
			}

			function parsesecurity(ent, cb){
				resetTimeout();

				if (opts.security){
					let security = 3;

					if (opts.security.indexOf('WPA2') >= 0 && opts.security.indexOf('802.1x') >= 0){
						security = 5;
						isEnterprise = true;
					} else if (opts.security.indexOf('WPA') >= 0 && opts.security.indexOf('802.1x') >= 0){
						security = 4;
						isEnterprise = true;
					} else if (opts.security.indexOf('WPA2') >= 0){
						security = 3;
					} else if (opts.security.indexOf('WPA') >= 0){
						security = 2;
					} else if (opts.security.indexOf('WEP') >= 0){
						security = 1;
					} else if (opts.security.indexOf('NONE') >= 0){
						security = 0;
					}

					return cb(security + '\n', startTimeout.bind(self, 10000));
				}

				const choices = [
					{ name: 'WPA2', value: 3 },
					{ name: 'WPA', value: 2 },
					{ name: 'WEP', value: 1 },
					{ name: 'Unsecured', value: 0 }
				];

				if (ent){
					choices.push({ name: 'WPA Enterprise', value: 4 });
					choices.push({ name: 'WPA2 Enterprise', value: 5 });
				}

				const question = {
					type: 'list',
					name: 'security',
					message: 'Security Type',
					choices: choices
				};

				prompt([question])
					.then((ans) => {
						if (ans.security > 3){
							isEnterprise = true;
						}
						cb(ans.security + '\n', startTimeout.bind(self, 10000));
					});
			}
		});

		return promise.finally(cleanUpFn);
	}
	/* eslint-enable max-statements */

	/**
	 * Sends a command to the device and retrieves the response.
	 * @param device    The device to send the command to
	 * @param command   The command text
	 * @param timeout   How long in milliseconds to wait for a response
	 * @returns {Promise} to send the command.
	 * The serial port should not be open, and is closed after the command is sent.
	 * @private
	 */
	_issueSerialCommand(device, command, timeout){
		if (!device){
			throw new VError('No serial port identified');
		}
		const failDelay = timeout || 5000;

		let serialPort;
		return new Promise((resolve, reject) => {
			serialPort = this.serialPort || new SerialPort(device.port, SERIAL_PORT_DEFAULTS);
			const parser = new SerialBatchParser({ timeout: 250 });
			serialPort.pipe(parser);

			const failTimer = setTimeout(() => {
				reject(timeoutError);
			}, failDelay);

			parser.on('data', (data) => {
				clearTimeout(failTimer);
				resolve(data.toString());
			});

			serialPort.open((err) => {
				if (err){
					console.error('Serial err: ' + err);
					console.error('Serial problems, please reconnect the device.');
					reject('Serial problems, please reconnect the device.');
					return;
				}

				serialPort.write(command, (werr) => {
					if (werr){
						reject(err);
					}
				});
			});
		})
			.finally(() => {
				if (serialPort){
					serialPort.removeAllListeners('open');

					if (serialPort.isOpen){
						return new Promise((resolve) => {
							serialPort.close(resolve);
						});
					}
				}
			});
	}

	getDeviceMacAddress(device){
		if (device.type === 'Core'){
			throw new VError('Unable to get MAC address of a Core');
		}

		return this._issueSerialCommand(device, 'm').then((data) => {
			const matches = data.match(/([0-9a-fA-F]{2}:){1,5}([0-9a-fA-F]{2})?/);

			if (matches){
				let mac = matches[0].toLowerCase();

				// manufacturing firmware can sometimes not report the full MAC
				// lets try and fix it
				if (mac.length < 17){
					const bytes = mac.split(':');

					while (bytes.length < 6){
						bytes.unshift('00');
					}

					const usiMacs = [
						['6c', '0b', '84'],
						['44', '39', 'c4']
					];

					usiMacs.some((usimac) => {
						for (let i = usimac.length - 1; i >= 0; i--){
							if (bytes[i] === usimac[i]){
								mac = usimac.concat(bytes.slice(usimac.length)).join(':');
								return true;
							}
						}
					});
				}
				return mac;
			}
			throw new VError('Unable to find mac address in response');
		});
	}

	getSystemInformation(device){
		return this._issueSerialCommand(device, 's', MODULE_INFO_COMMAND_TIMEOUT);
	}

	askForDeviceID(device){
		return this._issueSerialCommand(device, 'i', IDENTIFY_COMMAND_TIMEOUT)
			.then((data) => {
				const matches = data.match(/Your (core|device) id is\s+(\w+)/);

				if (matches && matches.length === 3){
					return matches[2];
				}

				const electronMatches = data.match(/\s+([a-fA-F0-9]{24})\s+/);

				if (electronMatches && electronMatches.length === 2){
					const info = { id: electronMatches[1] };
					const imeiMatches = data.match(/IMEI: (\w+)/);

					if (imeiMatches){
						info.imei = imeiMatches[1];
					}

					const iccidMatches = data.match(/ICCID: (\w+)/);

					if (iccidMatches){
						info.iccid = iccidMatches[1];
					}

					return info;
				}
			});
	}

	askForSystemFirmwareVersion(device, timeout){
		return this._issueSerialCommand(device, 'v', timeout)
			.then((data) => {
				const matches = data.match(/system firmware version:\s+([\w.-]+)/);

				if (matches && matches.length === 2){
					return matches[1];
				}
			});
	}

	sendDoctorAntenna(device, antenna, timeout){
		const antennaValues = { Internal: 'i', External: 'e' };
		const command = 'a' + antennaValues[antenna];
		return this._issueSerialCommand(device, command, timeout);
	}

	sendDoctorIP(device, mode, ipAddresses, timeout){
		const modeValues = {
			'Dynamic IP': 'd',
			'Static IP': 's'
		};

		let command = 'i' + modeValues[mode];

		if (mode === 'Static IP'){
			const ipAddressValues = [ipAddresses.device_ip, ipAddresses.netmask, ipAddresses.gateway, ipAddresses.dns];
			const ipAddressesInt = _.map(ipAddressValues, this._ipToInteger);
			command += ipAddressesInt.join(' ') + '\n';
		}

		return this._issueSerialCommand(device, command, timeout);
	}

	sendDoctorSoftAPPrefix(device, prefix, timeout){
		const command = 'p' + prefix + '\n';
		return this._issueSerialCommand(device, command, timeout);
	}

	sendDoctorClearEEPROM(device, timeout){
		const command = 'e';
		return this._issueSerialCommand(device, command, timeout);
	}

	sendDoctorClearWiFi(device, timeout){
		const command = 'c';
		return this._issueSerialCommand(device, command, timeout);
	}

	sendDoctorListenMode(device, timeout){
		const command = 'l';
		return this._issueSerialCommand(device, command, timeout);
	}

	_ipToInteger(ip){
		const parts = ip.split('.');

		if (parts.length !== 4){
			return 0;
		}

		return (((parts[0] * 256) + parts[1]) * 256 + parts[2]) * 256 + parts[3];
	}

	_parsePort(devices, comPort){
		if (!comPort){
			//they didn't give us anything.
			if (devices.length === 1){
				//we have exactly one device, use that.
				return devices[0];
			}
			//else - which one?
		} else {
			let portNum = parseInt(comPort);

			if (!isNaN(portNum)){
				//they gave us a number
				if (portNum > 0){
					portNum -= 1;
				}

				if (devices.length > portNum){
					//we have it, use it.
					return devices[portNum];
				}
				//else - which one?
			} else {
				const matchedDevices = devices.filter((d) => {
					return d.port === comPort;
				});

				if (matchedDevices.length){
					return matchedDevices[0];
				}

				//they gave us a string
				//doesn't matter if we have it or not, give it a try.
				return { port: comPort, type: '' };
			}
		}

		return null;
	}

	whatSerialPortDidYouMean(comPort){
		return this.findDevices()
			.then(devices => {
				const port = this._parsePort(devices, comPort);
				if (port){
					return port;
				}

				if (!devices || devices.length === 0){
					return;
				}

				const question = {
					name: 'port',
					type: 'list',
					message: 'Which device did you mean?',
					choices: devices.map((d) => {
						return {
							name: d.port + ' - ' + d.type + ' - ' + d.deviceId,
							value: d
						};
					})
				};

				return prompt([question])
					.then(answers => {
						return answers.port;
					});
			});
	}

	exit(){
		console.log();
		console.log(arrow, chalk.bold.white('Ok, bye! Don\'t forget `' +
			chalk.bold.cyan(cmd + ' help') + '` if you\'re stuck!',
		chalk.bold.magenta('<3'))
		);
		process.exit(0);
	}
};

