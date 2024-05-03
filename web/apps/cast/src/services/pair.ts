import log from "@/next/log";
import { toB64 } from "@ente/shared/crypto/internal/libsodium";
import castGateway from "@ente/shared/network/cast";
import { wait } from "@ente/shared/utils";
import _sodium from "libsodium-wrappers";
import { type Cast } from "../utils/useCastReceiver";

/**
 * Listen for pairing requests using the given {@link cast} instance. On
 * successful pairing, return the payload (JSON) sent by the sender who
 * connected to us.
 *
 * [Note: Pairing protocol]
 *
 * The Chromecast Framework (represented here by our handle to the Chromecast
 * Web SDK, {@link cast}) itself is used for only the initial handshake, none of
 * the data, even encrypted passes over it thereafter.
 *
 * The entire protocol is quite simple.
 *
 * 1. We (the receiver) generate a public/private keypair. and register the
 *    public part of it with museum.
 *
 * 2. Museum gives us a pairing "code" in lieu.
 *
 * 3. Listen for incoming messages over the Chromecast connection.
 *
 * 4. The client (our Web or mobile app) will connect using the "sender"
 *    Chromecast SDK. This will result in a bi-directional channel between us
 *    ("receiver") and the Ente client app ("sender").
 *
 * 5. Thereafter, if at any time the sender disconnects, close the Chromecast
 *    context. This effectively shuts us down, causing the entire page to get
 *    reloaded.
 *
 * 6. After connecting, the sender sends an (empty) message. We reply by sending
 *    them a message containing the pairing code. This exchange is the only data
 *    that traverses over the Chromecast connection.
 *
 * 5. In parallel, start polling museum to ask it if anyone has claimed that
 *    code we vended out and used that to send us an payload encrypted using our
 *    public key. This payload is a JSON object that contains the data we need
 *    to initiate a slideshow for a particular Ente collection.
 *
 * 6. When that happens, decrypt that data with our private key, and return it.
 */
export const pair = async (cast: Cast) => {
    // Generate keypair
    const keypair = await generateKeyPair();
    const publicKeyB64 = await toB64(keypair.publicKey);
    const privateKeyB64 = await toB64(keypair.privateKey);

    // Register keypair with museum to get a pairing code.
    let code: string;
    do {
        try {
            code = await castGateway.registerDevice(publicKeyB64);
        } catch (e) {
            log.error("Failed to register public key with server", e);
            // Schedule retry after 10 seconds.
            await wait(10000);
        }
    } while (code === undefined);

    // Prepare the Chromecast "context".
    const context = cast.framework.CastReceiverContext.getInstance();
    const namespace = "urn:x-cast:pair-request";

    const options = new cast.framework.CastReceiverOptions();
    // TODO(MR): Are any of these options required?
    options.maxInactivity = 3600;
    options.customNamespaces = Object.assign({});
    options.customNamespaces[namespace] =
        cast.framework.system.MessageType.JSON;
    options.disableIdleTimeout = true;

    // Reply with the code that we have if anyone asks over chromecast.
    const incomingMessageListener = ({ senderId }: { senderId: string }) =>
        context.sendCustomMessage(namespace, senderId, { code });

    context.addCustomMessageListener(
        namespace,
        // We need to cast, the `senderId` is present in the message we get but
        // not present in the TypeScript type.
        incomingMessageListener as unknown as SystemEventHandler,
    );

    // Shutdown ourselves if the "sender" disconnects.
    context.addEventListener(
        cast.framework.system.EventType.SENDER_DISCONNECTED,
        () => context.stop(),
    );

    // Start listening for Chromecast connections.
    context.start(options);

    // Start polling museum
    let decryptedJSON: unknown | undefined
    do {
        // The client will send us the encrypted payload using our public key
        // that we registered with museum. Then, we can decrypt this using the
        // private key of the pair and return the plaintext payload, which'll be
        // a JSON object containing all the data we need to play the collection
        // slideshow.
        let devicePayload = "";
        try {
            const encDastData = await castGateway.getCastData(`${deviceCode}`);
            if (!encDastData) return;
            devicePayload = encDastData;
        } catch (e) {
            setCodePending(true);
            init();
            return;
        }

        const decryptedPayload = await boxSealOpen(
            devicePayload,
            publicKeyB64,
            privateKeyB64,
        );

        const decryptedPayloadObj = JSON.parse(atob(decryptedPayload));

        return decryptedPayloadObj;
    };
};

const generateKeyPair = async () => {
    await _sodium.ready;
    return _sodium.crypto_box_keypair();
};
