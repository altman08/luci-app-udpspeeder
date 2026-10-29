'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require fs';
'require poll';
'require ui';

var INIT = '/etc/init.d/udpspeeder-luci';
var serviceList = rpc.declare({ object: 'service', method: 'list', params: [ 'name' ], expect: { '': {} } });

function splitEndpoint(value) {
	var match = /^\[([^\]]+)\]:(\d+)$/.exec(value || '') || /^([^:]+):(\d+)$/.exec(value || '');
	return match ? [ match[1], match[2] ] : [ '', '' ];
}

function endpoint(host, port) {
	return (host.indexOf(':') >= 0 ? '[' + host + ']' : host) + ':' + port;
}

function fecValid(sid, value) {
	var previous = 0;
	if (!value || value.length > 2500) return _("Enter FEC parameters, for example 20:10.");
	var valid = value.split(',').every(function(pair) {
		var match = /^(\d+):(\d+)$/.exec(pair);
		if (!match) return false;
		var x = Number(match[1]), y = Number(match[2]);
		if (x < 1 || y < 0 || x + y > 255 || x <= previous) return false;
		previous = x;
		return true;
	});
	return valid || _("Use x:y or x1:y1,x2:y2, where x >= 1, y >= 0, x + y <= 255, and x strictly increases.");
}

function windowValid(sid, value) {
	var match = /^(\d+)(?::(\d+))?$/.exec(value || '');
	return !!(match && Number(match[1]) <= 10000 &&
		(match[2] == null || (Number(match[1]) <= Number(match[2]) && Number(match[2]) <= 10000))) ||
		_("Enter an integer from 0 to 10000, or min:max with min <= max.");
}

function exec(action, sid) {
	return fs.exec(INIT, [ action, sid ]).then(function(res) {
		if (res.code !== 0) throw new Error(res.stderr || res.stdout || _("Operation failed"));
		return res.stdout || '';
	});
}

return view.extend({
	load: function() {
		return uci.load('udpspeeder');
	},

	refreshStatus: function() {
		var self = this;
		return serviceList('udpspeeder-luci').then(function(result) {
			self.instances = (result['udpspeeder-luci'] || {}).instances || {};
			self.statusError = false;
			return Promise.all(uci.sections('udpspeeder', 'udpspeeder').map(function(rule) {
				return exec('rule_status', rule['.name']).then(function(text) {
					var lines = text.trimEnd().split('\n');
					self.details[rule['.name']] = { state: lines[0], message: lines[1], resolved: lines[3] || '' };
				}).catch(function() { self.details[rule['.name']] = {}; });
			}));
		}).catch(function() {
			self.statusError = true;
		}).then(function() { self.updateRows(); });
	},

	updateRows: function() {
		var self = this;
		Object.keys(this.rows).forEach(function(sid) {
			var row = self.rows[sid];
			var running = !!(self.instances[sid] || {}).running;
			var detail = self.details[sid] || {};
			var error = detail.state === 'error' && (running || uci.get('udpspeeder', sid, 'enabled') === '1');
			var busy = self.busy === sid;
			row.status.textContent = busy ? _("Working…") : self.statusError ? _("Status query failed") :
				error ? _("Start failed") : running ? (detail.state === 'resolving' ? _("Resolving") : _("Running")) : _("Stopped");
			row.status.style.color = error ? '#c62828' : running ? '#2e7d32' : '#666';
			row.message.textContent = error ? detail.message || '' : detail.resolved ? _('Current target: %s').format(detail.resolved) : '';
			row.start.textContent = running ? _("Restart") : _("Start");
			row.start.disabled = !!self.busy || self.map.readonly || self.statusError;
			row.stop.disabled = !!self.busy || self.map.readonly || self.statusError || !running;
		});
	},

	showLog: function(sid) {
		var pre = E('pre', { 'style': 'max-height:60vh;overflow:auto;white-space:pre-wrap' }, _("Loading…"));
		var refresh = function() {
			return exec('rule_log', sid).then(function(text) { pre.textContent = text || _("No logs available"); })
				.catch(function(err) { pre.textContent = _('Read failed: %s').format(err.message); });
		};
		ui.showModal(_('Rule log: %s').format(uci.get('udpspeeder', sid, 'name') || sid), [
			E('p', {}, _("Logs are stored in memory separately for each rule. Global settings control the number of retained lines.")), pre,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, refresh) }, _("Refresh")),
				' ', E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Close'))
			])
		]);
		return refresh();
	},

	control: function(action, sid) {
		var self = this;
		if (this.busy || this.map.readonly) return Promise.resolve();
		this.busy = sid;
		this.updateRows();
		// Do not commit another browser session's pending edits through a rule action.
		return uci.changes().then(function(changes) {
			if (changes.udpspeeder && changes.udpspeeder.length)
				throw new Error(_("Configuration changes are pending. Save and apply them before controlling rules."));
			return exec(action, sid);
		}).then(function() {
			var enabled = action === 'rule_stop' ? '0' : '1';
			// Synchronize only this flag; preserve other edits in the open form.
			uci.set('udpspeeder', sid, 'enabled', enabled);
			var option = self.map.lookupOption('enabled', sid)[0];
			if (option) {
				option.cfgvalue(sid, enabled);
				var widget = option.getUIElement(sid);
				if (widget) widget.setValue(enabled);
			}
		}).catch(function(err) {
			ui.addNotification(null, E('p', {}, err.message), 'error');
		}).finally(function() {
			self.busy = null;
			return self.refreshStatus();
		});
	},

	render: function() {
		var self = this, m, s, o;
		this.rows = {}; this.details = {}; this.instances = {}; this.busy = null;
		m = this.map = new form.Map('udpspeeder', 'UDPSPEEDER',
			_("Reduce UDP packet loss using forward error correction (FEC) and redundant packets. Each rule is an independent client or server instance.") + ' ' +
			_("Enabled rules start automatically. Start and Stop update the enabled setting and use the saved parameters."));

		s = m.section(form.NamedSection, 'global', 'global', _("Global settings"));
		o = s.option(form.Value, 'dns_server', _("DNS server"), _("Leave empty to use the system DNS. Hostnames are resolved before startup; address changes restart only the affected rule."));
		o.datatype = 'ipaddr'; o.placeholder = _("System default");
		o = s.option(form.Value, 'check_interval', _("DNS check interval (seconds)"));
		o.datatype = 'range(10,86400)'; o.default = '60'; o.rmempty = false;
		o = s.option(form.Value, 'log_max', _("Log lines retained per rule"));
		o.datatype = 'range(10,1000)'; o.default = '100'; o.rmempty = false;

		s = m.section(form.GridSection, 'udpspeeder', _("Tunnel rules"),
			_("Servers listen on a public UDP port and forward traffic to the target service. Clients provide a local UDP endpoint. Allow the server listen port in the firewall."));
		s.anonymous = true; s.addremove = true; s.sortable = true; s.nodescriptions = true;
		s.addbtntitle = _("Add rule");
		s.tab('basic', _("Basic settings")); s.tab('fec', _("FEC settings")); s.tab('advanced', _("Advanced settings"));

		o = s.taboption('basic', form.Flag, 'enabled', _("Enabled"));
		o.default = '0'; o.rmempty = false; o.editable = true;
		o = s.taboption('basic', form.Value, 'name', _("Name"));
		o.placeholder = _("For example: WireGuard");
		o = s.taboption('basic', form.ListValue, 'server', _("Role"));
		o.value('0', _("Client")); o.value('1', _("Server")); o.default = '0'; o.rmempty = false;

		o = s.option(form.DummyValue, '_endpoint', _("Listen → target"));
		o.modalonly = false;
		o.textvalue = function(sid) {
			return (uci.get('udpspeeder', sid, 'local') || '—') + ' → ' + (uci.get('udpspeeder', sid, 'remote') || '—');
		};
		o = s.option(form.DummyValue, '_fec', _('FEC'));
		o.modalonly = false;
		o.textvalue = function(sid) {
			return uci.get('udpspeeder', sid, 'disable_fec') === '1' ? _("Disabled") : uci.get('udpspeeder', sid, 'fec') || '20:10';
		};
		o = s.option(form.DummyValue, '_status', _("Status / actions"));
		o.modalonly = false;
		o.textvalue = function(sid) {
			var row = { status: E('strong', {}, _("Loading…")), message: E('small') };
			row.start = E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button', 'disabled': true,
				'click': ui.createHandlerFn(self, function() {
					return self.control((self.instances[sid] || {}).running ? 'rule_restart' : 'rule_start', sid);
				}) }, _("Start"));
			row.stop = E('button', { 'class': 'cbi-button cbi-button-negative', 'type': 'button', 'disabled': true,
				'click': ui.createHandlerFn(self, 'control', 'rule_stop', sid) }, _("Stop"));
			self.rows[sid] = row;
			return E('div', {}, [ E('div', {}, row.status), E('div', {}, row.message),
				E('div', { 'style': 'display:flex;gap:4px;margin-top:6px;flex-wrap:wrap' }, [ row.start, row.stop,
					E('button', { 'class': 'cbi-button', 'type': 'button',
						'click': ui.createHandlerFn(self, 'showLog', sid) }, _("Logs")) ]) ]);
		};

		// Virtual fields provide separate address/port inputs while retaining the core schema.
		[ [ 'local', _('Local listen address'), _('Local listen port'), '127.0.0.1' ], [ 'remote', _('Target address'), _('Target port'), '' ] ].forEach(function(item) {
			var storage = item[0], hostOption, portOption;
			hostOption = s.taboption('basic', form.Value, '_' + storage + '_host', item[1],
				storage === 'remote' ? _("For clients, enter the UDPspeeder server address. For servers, enter the target UDP service address. IP addresses and hostnames are supported.") :
					_("Clients usually listen on 127.0.0.1. Servers can use 0.0.0.0 or ::. IPv6 dual-stack behavior depends on system settings."));
			hostOption.modalonly = true; hostOption.rmempty = false;
			hostOption.datatype = storage === 'local' ? 'ipaddr' : 'host';
			hostOption.placeholder = item[3];
			hostOption.cfgvalue = function(sid) { return splitEndpoint(uci.get('udpspeeder', sid, storage))[0]; };
			portOption = s.taboption('basic', form.Value, '_' + storage + '_port', item[2]);
			portOption.modalonly = true; portOption.rmempty = false; portOption.datatype = 'range(1,65535)';
			portOption.cfgvalue = function(sid) { return splitEndpoint(uci.get('udpspeeder', sid, storage))[1]; };
			hostOption.write = function(sid, value) { uci.set('udpspeeder', sid, storage, endpoint(value, portOption.formvalue(sid))); };
			portOption.write = function(sid, value) { uci.set('udpspeeder', sid, storage, endpoint(hostOption.formvalue(sid), value)); };
		});

		o = s.taboption('basic', form.ListValue, 'family', _("Target hostname address family"));
		o.value('auto', _("Automatic (prefer IPv4)")); o.value('ipv4', _("IPv4 only")); o.value('ipv6', _("IPv6 only"));
		o.default = 'auto'; o.modalonly = true;
		o = s.taboption('basic', form.Value, 'key', _("Key"), _("Must match on both ends. Used for simple XOR obfuscation, not strong encryption. May be empty and must not contain whitespace."));
		o.password = true; o.modalonly = true;
		o.validate = function(sid, value) { return !value || (value.length <= 256 && !/\s/.test(value)) || _("The key must not exceed 256 characters or contain whitespace."); };
		o = s.taboption('basic', form.Flag, 'disable_obscure', _("Disable random obfuscation"), _("Must match on both ends. Disabling random padding reduces bandwidth and CPU overhead."));
		o.modalonly = true; o.default = '0'; o.rmempty = false;

		o = s.taboption('fec', form.Flag, 'disable_fec', _("Disable FEC"), _("Must match on both ends. When enabled, this runs as a plain UDP tunnel."));
		o.modalonly = true; o.default = '0'; o.rmempty = false;
		o = s.taboption('fec', form.Value, 'fec', _("FEC redundancy parameters"), _("20:10 adds 10 redundant shards for every 20 data shards. Multiple groups are supported, for example 1:3,2:4,8:6,20:10. Encoding parameters may differ between ends."));
		o.default = '20:10'; o.modalonly = true; o.rmempty = false; o.validate = fecValid; o.depends('disable_fec', '0');
		o = s.taboption('fec', form.ListValue, 'mode', _("FEC mode"));
		o.value('0', _("0: Fragment and aggregate to save bandwidth")); o.value('1', _("1: Encode per packet; check the MTU"));
		o.default = '0'; o.modalonly = true; o.rmempty = false; o.depends('disable_fec', '0');

		function number(tab, name, title, min, max, value, description) {
			var option = s.taboption(tab, form.Value, name, title, description);
			option.datatype = 'range(' + min + ',' + max + ')'; option.default = value;
			option.modalonly = true; option.rmempty = false;
			return option;
		}
		number('fec', 'mtu', _('FEC MTU'), 100, 2000, '1250', _("Keep the default value unless needed. Mode 0 fragments packets; mode 1 does not.")).depends('disable_fec', '0');
		number('fec', 'timeout', _("Encoding timeout (ms)"), 0, 1000, '8').depends('disable_fec', '0');
		number('fec', 'queue_len', _("Maximum encoding queue length"), 1, 10000, '200').depends({ mode: '0', disable_fec: '0' });
		o = s.taboption('fec', form.Flag, 'fix_latency', _("Stabilize latency"));
		o.modalonly = true; o.default = '0'; o.rmempty = false; o.depends({ mode: '0', disable_fec: '0' });
		[ [ 'interval', _("Packet spreading interval (ms)") ], [ 'jitter', _("Simulated jitter (ms)") ] ].forEach(function(item) {
			var option = s.taboption('advanced', form.Value, item[0], item[1], _("Accepts an integer or min:max. Set to 0 to disable."));
			option.default = '0'; option.modalonly = true; option.rmempty = false; option.validate = windowValid;
		});
		number('advanced', 'sock_buf', _("Socket buffer (KB)"), 10, 10240, '1024');
		number('advanced', 'decode_buf', _("Decoder buffer (packets)"), 300, 20000, '2000');
		number('advanced', 'report', _("Traffic report interval (seconds)"), 0, 86400, '0', _("Set to 0 to disable, or specify the interval between reports."));
		number('advanced', 'random_drop', _("Simulated packet loss (0.01%)"), 0, 10000, '0', _("For debugging. Usually leave at 0. A value of 100 simulates 1% packet loss."));
		o = s.taboption('advanced', form.Flag, 'disable_checksum', _("Disable checksum"), _("Must match on both ends. Usually leave disabled."));
		o.modalonly = true; o.default = '0'; o.rmempty = false;
		o = s.taboption('advanced', form.Value, 'out_interface', _("Target output device"), _("Passed to --out-interface. Enter an actual device name, for example pppoe-wan. Leave empty to use system routing."));
		o.modalonly = true;
		o.validate = function(sid, value) { return !value || /^[A-Za-z0-9_.:@-]{1,15}$/.test(value) || _("Enter a valid device name of at most 15 characters."); };
		o = s.taboption('advanced', form.ListValue, 'log_level', _("Log level"));
		[ _("Off"), _("Fatal"), _("Error"), _("Warning"), _("Info"), _("Debug"), _("Trace") ].forEach(function(label, i) { o.value(String(i), label); });
		o.default = '4'; o.modalonly = true; o.rmempty = false;

		if (this.pollFn) poll.remove(this.pollFn);
		this.pollFn = this.refreshStatus.bind(this);
		return m.render().then(function(node) {
			poll.add(self.pollFn, 5);
			self.refreshStatus();
			return node;
		});
	}
});
