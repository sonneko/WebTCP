/**
 * node-datachannel の既定バインドの判定規則（#61 / 設計 §3.40）。純関数の表形式テスト（ネイティブ依存なし）。
 * 入力は `os.networkInterfaces()` と同じ形の偽の列挙。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseNodeDatachannelDefaultBindAddress } from '../dist/adapters/webrtc/nodeProvider.js';

const v4 = (address, internal = false) => ({ address, netmask: '255.255.255.0', family: 'IPv4', internal });
const v6 = (address, internal = false) => ({ address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal });
const LO = { lo: [v4('127.0.0.1', true), v6('::1', true)] };

const cases = [
    {
        name: 'link-local IPv4 only (the #61 host): binds to that address',
        interfaces: { ...LO, eth0: [v4('169.254.0.21'), v6('fe80::fc:ff:fe00:5')] },
        expected: '169.254.0.21',
    },
    {
        name: 'a routable IPv4 address exists: the default stays (undefined)',
        interfaces: { ...LO, eth0: [v4('169.254.0.21')], wlan0: [v4('192.168.1.10')] },
        expected: undefined,
    },
    {
        name: 'a global IPv6 address exists: the default stays (undefined)',
        interfaces: { ...LO, eth0: [v4('169.254.0.21')], eth1: [v6('2001:db8::1')] },
        expected: undefined,
    },
    {
        name: 'loopback only: nothing to replace (undefined)',
        interfaces: { ...LO },
        expected: undefined,
    },
    {
        name: 'IPv6 link-local only: not handled here (undefined)',
        interfaces: { ...LO, eth0: [v6('fe80::1')] },
        expected: undefined,
    },
    {
        name: 'link-local IPv4 and IPv6: the IPv4 address is chosen',
        interfaces: { ...LO, eth0: [v6('fe80::1'), v4('169.254.10.20')] },
        expected: '169.254.10.20',
    },
    {
        name: 'an internal entry is ignored, even if it is link-local',
        interfaces: { ...LO, eth0: [v4('169.254.0.21', true)] },
        expected: undefined,
    },
    {
        name: 'no interfaces at all (undefined)',
        interfaces: {},
        expected: undefined,
    },
];

for (const c of cases) {
    test(`default bind (#61): ${c.name}`, () => {
        assert.equal(chooseNodeDatachannelDefaultBindAddress(c.interfaces), c.expected);
    });
}
