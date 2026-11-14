import test from 'node:test';
import assert from 'node:assert/strict';
import { NameServer, WebTCPNetwork, NodeKeyManager, KeyDirectory, noopLogger, BinaryPacketSerializer, Ed25519PacketVerifier } from '../dist/index.js';
import { LoopbackNetwork, waitFor } from './helpers/loopback.mjs';

test('nameserver-network: RT_UPDATE propagates remote public keys without pre-sharing and URL connects over 3 nodes', async () => {
    const hub = new LoopbackNetwork();
    const keys = await Promise.all([NodeKeyManager.create(), NodeKeyManager.create(), NodeKeyManager.create()]);
    const nodes = keys.map((keyManager) => new WebTCPNetwork({
        channel: hub.createChannel(keyManager.nodeId), keyManager, logger: noopLogger,
        transport: { connectTimeoutMs: 3000, stream: { timeWaitMs: 0 } },
    }));
    const [a, b, c] = nodes;
    await Promise.all(nodes.map((n) => n.start()));
    const nsA = new NameServer(a, { logger: noopLogger, queryTimeoutMs: 1500, resolveTimeoutMs: 4000 });
    const nsB = new NameServer(b, { logger: noopLogger });
    const nsC = new NameServer(c, { logger: noopLogger });
    nsB.listen(); nsC.listen();
    nsC.registerA('remote-service', c.localNodeId);
    nsB.registerCNAME('remote-alias', 'remote-service');
    try {
        await a.connectToPeer(b.localNodeId);
        await b.connectToPeer(c.localNodeId);
        await waitFor(() => a.getRoutingTable().getEntry(c.localNodeId)?.cost === 2, { timeoutMs: 4000 });
        await waitFor(() => a.keyDirectory.get(c.localNodeId) !== undefined, { timeoutMs: 4000 });
        const resolved = await nsA.resolve('remote-alias');
        assert.equal(resolved.nodeId, c.localNodeId);
        let got = '';
        c.listen(9000, (stream) => {
            stream.on('data', (data) => { got = new TextDecoder().decode(data); void stream.send('pong'); });
            stream.on('end', () => stream.end());
        });
        const stream = await a.connectURL(`webtcp://remote-service:9000/path`, { nameServer: nsA });
        const reply = stream.readExact(4);
        await stream.send('ping');
        assert.equal(new TextDecoder().decode(await reply), 'pong');
        assert.equal(got, 'ping');
        stream.destroy();
    } finally {
        nsA.close(); nsB.close(); nsC.close(); nodes.forEach((n) => n.close());
    }
});

test('nameserver-network: rejects non-neighbor, sender-mismatched and TTL=0 RT_UPDATE', async () => {
    const hub = new LoopbackNetwork();
    const local = await NodeKeyManager.create();
    const remote = await NodeKeyManager.create();
    const channel = hub.createChannel(local.nodeId);
    const network = new WebTCPNetwork({ channel, keyManager: local, logger: noopLogger });
    await network.start();
    const verifier = new Ed25519PacketVerifier({ keyManager: remote, keyDirectory: new KeyDirectory() });
    const serializer = new BinaryPacketSerializer();
    const make = async (overrides) => {
        const packet = {
            senderId: remote.nodeId, destinationId: local.nodeId, ttl: 64, signature: new Uint8Array(0),
            sourcePort: 0, destinationPort: 0, flags: 'RT_UPDATE', seqNum: 0, ackNum: 0,
            payload: new TextEncoder().encode(JSON.stringify({ senderId: remote.nodeId, entries: [], publicKey: Buffer.from(remote.publicKey).toString('base64url') })),
            ...overrides,
        };
        const signed = await verifier.signPacket(packet);
        return serializer.serialize(signed);
    };
    try {
        // not a neighbor
        channel.emit('data', remote.nodeId, await make({}));
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(network.getRoutingTable().getEntry(remote.nodeId), null);
        // become neighbor but TTL=0
        channel.connectedPeers.set(remote.nodeId, true);
        channel.emit('data', remote.nodeId, await make({ ttl: 0 }));
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(network.getRoutingTable().getEntry(remote.nodeId), null);
        // payload sender mismatch
        network.routingLayer.manager.handleRoutingInfoPayload(remote.nodeId, new TextEncoder().encode(JSON.stringify({ senderId: 'a'.repeat(32), entries: [] })));
        assert.equal(network.getRoutingTable().getEntry(remote.nodeId), null);
        // destination mismatch
        channel.emit('data', remote.nodeId, await make({ destinationId: 'c'.repeat(32) }));
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(network.getRoutingTable().getEntry(remote.nodeId), null);
        // valid update installs route
        channel.emit('data', remote.nodeId, await make({}));
        await waitFor(() => network.getRoutingTable().getEntry(remote.nodeId)?.cost === 1);
    } finally {
        network.close();
    }
});
