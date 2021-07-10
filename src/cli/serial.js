const unindent = require('../lib/unindent');


module.exports = ({ commandProcessor, root }) => {
	const serial = commandProcessor.createCategory(root, 'serial', 'Simple serial interface to your devices');

	const portOption = {
		'port': {
			describe: 'Use this serial port instead of auto-detecting. Useful if there are more than 1 connected device'
		}
	};

	commandProcessor.createCommand(serial, 'list', 'Show devices connected via serial to your computer', {
		handler: () => {
			const SerialCommands = require('../cmd/serial');
			return new SerialCommands().listDevices();
		}
	});

	commandProcessor.createCommand(serial, 'monitor', 'Connect and display messages from a device', {
		options: Object.assign({
			'follow': {
				boolean: true,
				description: 'Reopen the port after it closes, for example when the device resets'
			}
		}, portOption),
		handler: (args) => {
			const SerialCommands = require('../cmd/serial');
			return new SerialCommands().monitorPort(args);
		}
	});

	commandProcessor.createCommand(serial, 'identify', 'Ask for and display device ID via serial', {
		options: portOption,
		handler: (args) => {
			const SerialCommands = require('../cmd/serial');
			return new SerialCommands().identifyDevice(args);
		}
	});

	commandProcessor.createCommand(serial, 'wifi', 'Configure Wi-Fi credentials over serial', {
		options: Object.assign({
			'file': {
				description: 'Take the credentials from a JSON file instead of prompting for them'
			},
			'clear': {
				boolean: true,
				description: 'Remove existing credentials in the device'
			}
		}, portOption),
		handler: (args) => {
			const SerialCommands = require('../cmd/serial');
			return new SerialCommands().configureWifi(args);
		},
		examples: {
			'$0 $command': 'Prompt for Wi-Fi credentials and send them to a device over serial',
			'$0 $command --file credentials.json': 'Read Wi-Fi credentials from credentials.json and send them to a device over serial',
			'$0 $command --clear': 'Clear device stored Wi-Fi credentials'
		},
		epilogue: unindent(`
			The JSON file for passing Wi-Fi credentials should look like this:
			{
			  "network": "my_ssid",
			  "security": "WPA2_AES",
			  "password": "my_password"
			}
			
			The security property can be NONE, WEP, WPA2_AES, WPA2_TKIP, WPA2_AES+TKIP, WPA_AES, WPA_TKIP, WPA_AES+TKIP.
			For enterprise Wi-Fi, set security to WPA_802.1x or WPA2_802.1x and provide the eap, username, outer_identity, client_certificate, private_key and root_ca properties.
		`)
	});

	commandProcessor.createCommand(serial, 'mac', 'Ask for and display MAC address via serial', {
		options: portOption,
		handler: (args) => {
			const SerialCommands = require('../cmd/serial');
			return new SerialCommands().deviceMac(args);
		}
	});

	commandProcessor.createCommand(serial, 'inspect', 'Ask for and display device module information via serial', {
		options: portOption,
		handler: (args) => {
			const SerialCommands = require('../cmd/serial');
			return new SerialCommands().inspectDevice(args);
		}
	});

	commandProcessor.createCommand(serial, 'flash', 'Flash firmware over serial using YMODEM protocol', {
		params: '<binary>',
		options: Object.assign({
			'yes': {
				boolean: true,
				description: 'Answer yes to all questions'
			},
		}, portOption),
		handler: (args) => {
			const SerialCommands = require('../cmd/serial');
			return new SerialCommands().flashDevice(args.params.binary, args);
		}
	});

	commandProcessor.createCommand(serial, 'claim', 'Claim a device with the given claim code', {
		params: '<claimCode>',
		options: portOption,
		handler: (args) => {
			const SerialCommands = require('../cmd/serial');
			return new SerialCommands().claimDevice(args);
		}
	});

	return serial;
};

