'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const source = readFileSync(resolve(__dirname, '../luci-app-udpspeeder/htdocs/luci-static/resources/view/udpspeeder/config.js'), 'utf8');
const po = readFileSync(resolve(__dirname, '../luci-app-udpspeeder/po/zh_Hans/udpspeeder.po'), 'utf8');
const catalog = Object.fromEntries([...po.matchAll(/^msgid (".+")\nmsgstr (".+")$/gm)]
	.map(match => [ JSON.parse(match[1]), JSON.parse(match[2]) ]));
// LuCI provides String.format() globally; this view uses only %s substitutions.
String.prototype.format = function(...args) {
	let index = 0;
	return this.replace(/%s/g, () => String(args[index++]));
};

function setup(language = 'en') {
	const calls = [], notices = [], options = {}, modals = [];
	const data = { global: { '.type': 'global' }, tunnel1: { '.type': 'udpspeeder', '.name': 'tunnel1',
		local: '[::1]:9000', remote: 'peer.example:9001', enabled: '1', server: '0' } };
	const state = { changes: {}, code: 0, stdout: '', instances: {}, statusFailure: false };
	const uci = {
		load: async () => data,
		get: (config, sid, key) => key ? data[sid]?.[key] : data[sid],
		set: (config, sid, key, value) => { data[sid][key] = value; },
		sections: (config, type) => Object.values(data).filter(s => s['.type'] === type),
		changes: async () => state.changes
	};
	class Option {
		constructor(name, title) { this.option = name; this.title = title; this.values = []; }
		value(...args) { this.values.push(args); }
		depends() {}
		cfgvalue(sid, value) { if (value != null) this.saved = value; return this.saved ?? data[sid]?.[this.option]; }
		getUIElement() { return this.widget || null; }
	}
	const section = { tab() {}, option(type, name, title) { return options[name] = new Option(name, title); },
		taboption(tab, type, name, title) { return this.option(type, name, title); } };
	class Map {
		constructor() { this.readonly = false; }
		section() { return section; }
		render() { return Promise.resolve({}); }
		lookupOption(name) { return [ options[name] ]; }
	}
	const E = (tag, attrs, children) => ({ tag, attrs, children, style: {}, textContent: '' });
	const view = new Function('view', 'form', 'uci', 'rpc', 'fs', 'poll', 'ui', 'E', '_', source)(
		{ extend: x => x }, { Map }, uci,
		{ declare: () => async () => { if (state.statusFailure) throw Error('offline'); return { 'udpspeeder-luci': { instances: state.instances } }; } },
		{ exec: async (path, args) => { calls.push([path, ...args]); return { code: state.code, stdout: state.stdout, stderr: state.code ? 'backend failed' : '' }; } },
		{ add() {}, remove() {} },
		{ createHandlerFn: () => () => {}, addNotification: (title, body) => notices.push(body.children),
			showModal: (title, body) => modals.push({ title, body }) }, E,
		message => language === 'zh-cn' ? catalog[message] ?? message : message);
	return { view, data, state, calls, notices, options, modals };
}

test('split endpoint widgets retain the core schema and bracket IPv6', async () => {
	const { view, data, options } = setup();
	await view.render();
	assert.equal(options._local_host.cfgvalue('tunnel1'), '::1');
	assert.equal(options._local_port.cfgvalue('tunnel1'), '9000');
	options._local_host.formvalue = () => '2001:db8::1';
	options._local_port.formvalue = () => '12345';
	options._local_port.write('tunnel1', '12345');
	assert.equal(data.tunnel1.local, '[2001:db8::1]:12345');
	assert.equal(data.tunnel1._local_port, undefined);
	assert.deepEqual(options.server.values, [['0', 'Client'], ['1', 'Server']]);
	assert.deepEqual(options.mode.values.map(x => x[0]), ['0', '1']);
});

test('FEC validation covers limits, ordering and malformed groups', async () => {
	const { view, options } = setup(); await view.render();
	for (const fec of ['20:10', '1:3,2:4,8:6,20:10', '255:0', '1:254'])
		assert.equal(options.fec.validate('', fec), true, fec);
	for (const fec of ['', '0:1', '1:255', '20:10,10:5', '1:2,1:3', '1:-1', '1:2,', '1:2oops'])
		assert.notEqual(options.fec.validate('', fec), true, fec);
	for (const value of ['0', '10', '0:10000']) assert.equal(options.interval.validate('', value), true);
	for (const value of ['2:1', '-1', '10001', '1:2:3']) assert.notEqual(options.interval.validate('', value), true);
});

test('failed backend actions report errors and preserve the enable flag', async () => {
	const { view, state, data, notices } = setup(); await view.render();
	state.code = 1;
	await view.control('rule_stop', 'tunnel1');
	assert.equal(data.tunnel1.enabled, '1');
	assert.ok(notices.includes('backend failed'));
	assert.equal(view.busy, null);
});

test('read-only users and unapplied changes cannot invoke controls', async () => {
	const { view, state, calls, notices } = setup(); await view.render();
	await new Promise(setImmediate); calls.length = 0;
	view.map.readonly = true;
	await view.control('rule_stop', 'tunnel1');
	assert.equal(calls.length, 0);
	view.map.readonly = false; state.changes = { udpspeeder: [['set', 'tunnel1', 'key', 'pending']] };
	await view.control('rule_stop', 'tunnel1');
	assert.ok(!calls.some(x => x[1] === 'rule_stop'));
	assert.ok(notices.some(x => x.includes('changes are pending')));
});

test('an enabled flag change preserves other edits and uses a stable section ID', async () => {
	const { view, data, calls } = setup(); await view.render();
	data.tunnel1.name = '中文备注 / spaces';
	data.tunnel1.remote = 'edited.example:9999';
	await view.control('rule_stop', 'tunnel1');
	assert.equal(data.tunnel1.enabled, '0');
	assert.equal(data.tunnel1.remote, 'edited.example:9999');
	assert.ok(calls.some(x => x[1] === 'rule_stop' && x[2] === 'tunnel1'));
});

test('status distinguishes process failure from an available service', async () => {
	const { view, state, options } = setup(); await view.render();
	options._status.textvalue('tunnel1');
	state.instances = { tunnel1: { running: true } }; state.stdout = 'error\nInvalid settings\n\n203.0.113.1\n';
	await view.refreshStatus();
	assert.equal(view.rows.tunnel1.status.textContent, 'Start failed');
	assert.equal(view.rows.tunnel1.message.textContent, 'Invalid settings');
	state.statusFailure = true; await view.refreshStatus();
	assert.equal(view.rows.tunnel1.status.textContent, 'Status query failed');
	assert.equal(view.rows.tunnel1.start.disabled, true);
});

test('overlapping row actions issue only one mutation', async () => {
	const { view, calls } = setup(); await view.render();
	await Promise.all([view.control('rule_stop', 'tunnel1'), view.control('rule_restart', 'tunnel1')]);
	assert.equal(calls.filter(x => /^rule_(stop|restart)$/.test(x[1])).length, 1);
});

test('all translated UI messages have a nonempty Chinese translation and matching placeholders', () => {
	assert.doesNotMatch(source, /[\u3400-\u9fff]/);
	const messages = [...source.matchAll(/_\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)/g)]
		.map(match => new Function('return ' + match[1])());
	assert.ok(messages.length > 90);
	for (const message of messages) {
		assert.ok(catalog[message], message);
		assert.equal((catalog[message].match(/%s/g) || []).length, (message.match(/%s/g) || []).length, message);
	}
});

for (const language of ['en', 'zh-cn']) {
	test('labels, status, dialogs and validation follow the ' + language + ' catalog', async () => {
		const { view, options, state, modals, notices } = setup(language);
		const chinese = language === 'zh-cn';
		await view.render();
		assert.deepEqual(options.server.values, chinese ? [['0', '客户端'], ['1', '服务端']] : [['0', 'Client'], ['1', 'Server']]);
		assert.equal(options._local_port.title, chinese ? '本地监听端口' : 'Local listen port');
		assert.equal(options.fec.validate('', ''), chinese ? '请输入 FEC 参数，例如 20:10。' : 'Enter FEC parameters, for example 20:10.');
		options._status.textvalue('tunnel1');
		state.instances = { tunnel1: { running: true } };
		state.stdout = 'running\n\n\n203.0.113.10\n';
		await view.refreshStatus();
		assert.equal(view.rows.tunnel1.status.textContent, chinese ? '运行中' : 'Running');
		assert.equal(view.rows.tunnel1.message.textContent, chinese ? '当前目标：203.0.113.10' : 'Current target: 203.0.113.10');
		state.stdout = '';
		await view.showLog('tunnel1');
		assert.equal(modals[0].title, chinese ? '规则日志：tunnel1' : 'Rule log: tunnel1');
		assert.equal(modals[0].body[1].textContent, chinese ? '暂无日志' : 'No logs available');
		state.code = 1;
		await view.showLog('tunnel1');
		assert.equal(modals[1].body[1].textContent, chinese ? '读取失败：backend failed' : 'Read failed: backend failed');
		state.changes = { udpspeeder: [['set', 'tunnel1', 'key', 'pending']] };
		await view.control('rule_stop', 'tunnel1');
		assert.ok(notices.some(text => text.includes(chinese ? '尚未应用' : 'changes are pending')));
	});
}
