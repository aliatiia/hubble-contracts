import {
    BigNumber,
    BigNumberish,
    BytesLike,
    ContractTransaction,
    Event
} from "ethers";
import {
    arrayify,
    concat,
    hexlify,
    hexZeroPad,
    keccak256,
    solidityKeccak256,
    solidityPack
} from "ethers/lib/utils";
import { Rollup } from "../../../types/ethers-contracts/Rollup";
import { aggregate, BlsVerifier, SignatureInterface } from "../../blsSigner";
import { float16 } from "../../decimal";
import { Group } from "../../factory";
import { DeploymentParameters } from "../../interfaces";
import { dumpG1, loadG1, parseG1, solG1 } from "../../mcl";
import { sum, sumNumber } from "../../utils";
import {
    processReceiver,
    processSender,
    validateReceiver,
    validateSender
} from "../stateTransitions";
import { StateStorageEngine, StorageManager } from "../storageEngine";
import { SameTokenPool } from "../txPool";
import { BaseCommitment, ConcreteBatch } from "./base";
import {
    SolStruct,
    CompressedTx,
    OffchainTx,
    StateIDLen,
    FloatLength,
    BatchHandlingStrategy,
    BatchPackingCommand
} from "./interface";

export class TransferCompressedTx implements CompressedTx {
    public readonly txType = "0x01";
    static readonly byteLengths = [
        StateIDLen,
        StateIDLen,
        FloatLength,
        FloatLength
    ];
    constructor(
        public readonly fromIndex: number,
        public readonly toIndex: number,
        public readonly amount: BigNumber,
        public readonly fee: BigNumber
    ) {}

    serialize(): string {
        const concated = concat([
            hexZeroPad(hexlify(this.fromIndex), StateIDLen),
            hexZeroPad(hexlify(this.toIndex), StateIDLen),
            float16.compress(this.amount),
            float16.compress(this.fee)
        ]);
        return hexlify(concated);
    }
    static deserialize(bytes: Uint8Array) {
        let position = 0;
        let bytesArray: Uint8Array[] = [];
        const sum = sumNumber(this.byteLengths);
        if (bytes.length != sum) throw new Error("invalid bytes");
        for (const len of this.byteLengths) {
            bytesArray.push(bytes.slice(position, position + len));
            position += len;
        }
        const fromIndex = BigNumber.from(bytesArray[0]).toNumber();
        const toIndex = BigNumber.from(bytesArray[1]).toNumber();
        const amount = float16.decompress(bytesArray[2]);
        const fee = float16.decompress(bytesArray[3]);
        return new this(fromIndex, toIndex, amount, fee);
    }

    message(nonce: number): string {
        return solidityPack(
            ["uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
            [
                this.txType,
                this.fromIndex,
                this.toIndex,
                nonce,
                this.amount,
                this.fee
            ]
        );
    }
}
export class TransferOffchainTx extends TransferCompressedTx
    implements OffchainTx {
    constructor(
        public readonly fromIndex: number,
        public readonly toIndex: number,
        public readonly amount: BigNumber,
        public readonly fee: BigNumber,
        public nonce: number,
        public signature?: SignatureInterface
    ) {
        super(fromIndex, toIndex, amount, fee);
    }

    toCompressed() {
        return new TransferCompressedTx(
            this.fromIndex,
            this.toIndex,
            this.amount,
            this.fee
        );
    }

    public message(): string {
        return this.toCompressed().message(this.nonce);
    }

    serialize(): string {
        if (!this.signature) throw new Error("Signature must be assigned");
        const concated = concat([
            hexZeroPad(hexlify(this.fromIndex), StateIDLen),
            hexZeroPad(hexlify(this.toIndex), StateIDLen),
            float16.compress(this.amount),
            float16.compress(this.fee),
            hexZeroPad(hexlify(this.nonce), StateIDLen),
            dumpG1(this.signature?.sol)
        ]);
        return hexlify(concated);
    }

    hash() {
        return keccak256(this.serialize());
    }

    static deserialize(bytes: Uint8Array) {
        const decompress = (input: Uint8Array) => float16.decompress(input);
        const fields = [
            {
                name: "fromIndex",
                length: StateIDLen,
                constructor: BigNumber.from
            },
            {
                name: "toIndex",
                length: StateIDLen,
                constructor: BigNumber.from
            },
            {
                name: "amount",
                length: FloatLength,
                constructor: decompress
            },
            {
                name: "fee",
                length: FloatLength,
                constructor: decompress
            },
            { name: "nonce", length: StateIDLen, constructor: BigNumber.from },
            { name: "signature", length: 64, constructor: hexlify }
        ];
        const sum = sumNumber(fields.map(x => x.length));
        if (bytes.length != sum) throw new Error("invalid bytes");
        const obj: any = {};
        let position = 0;
        for (const field of fields) {
            const byteSlice = bytes.slice(position, position + field.length);
            position += field.length;
            obj[field.name] = field.constructor(byteSlice);
        }
        const solG1 = loadG1(obj.signature);
        const mclG1 = parseG1(solG1);
        const signature = { sol: solG1, mcl: mclG1 };

        return new this(
            obj.fromIndex.toNumber(),
            obj.toIndex.toNumber(),
            obj.amount,
            obj.fee,
            obj.nonce.toNumber(),
            signature
        );
    }

    public toString(): string {
        return `<Transfer ${this.fromIndex}->${this.toIndex} $${this.amount}  fee ${this.fee}  nonce ${this.nonce}>`;
    }
}

export function getAggregateSig(txs: OffchainTx[]): solG1 {
    const signatures = [];
    for (const tx of txs) {
        if (!tx.signature) throw new Error(`tx has no signautre ${tx}`);
        signatures.push(tx.signature);
    }
    return aggregate(signatures).sol;
}

export function compress(txs: OffchainTx[]): string {
    return hexlify(concat(txs.map(tx => tx.toCompressed().serialize())));
}

export class TransferCommitment extends BaseCommitment {
    constructor(
        public stateRoot: BytesLike,
        public accountRoot: BytesLike,
        public signature: solG1,
        public feeReceiver: BigNumberish,
        public txs: BytesLike
    ) {
        super(stateRoot);
    }

    static fromTxs(
        txs: TransferOffchainTx[],
        stateRoot: BytesLike,
        accountRoot: BytesLike,
        feeReceiver: BigNumberish
    ) {
        const signature = getAggregateSig(txs);
        const compressedTx = compress(txs);
        return new this(
            stateRoot,
            accountRoot,
            signature,
            feeReceiver,
            compressedTx
        );
    }

    public toSolStruct(): SolStruct {
        return {
            stateRoot: this.stateRoot,
            body: {
                accountRoot: this.accountRoot,
                signature: this.signature,
                feeReceiver: this.feeReceiver,
                txs: this.txs
            }
        };
    }
    public decompressTxs(): TransferCompressedTx[] {
        const bytes = arrayify(this.txs);
        const txLen = sumNumber(TransferCompressedTx.byteLengths);
        if (bytes.length % txLen != 0) throw new Error("invalid bytes");
        let txs = [];
        for (let i = 0; i < bytes.length; i += txLen) {
            const tx = TransferCompressedTx.deserialize(
                bytes.slice(i, i + txLen)
            );
            txs.push(tx);
        }
        return txs;
    }

    get bodyRoot(): string {
        return solidityKeccak256(
            ["bytes32", "uint256[2]", "uint256", "bytes"],
            [this.accountRoot, this.signature, this.feeReceiver, this.txs]
        );
    }
}

async function validateTransferStateTransition(
    tx: TransferOffchainTx,
    tokenID: number,
    storage: StorageManager,
    verifier: BlsVerifier
) {
    const sender = await storage.state.get(tx.fromIndex);
    const receiver = await storage.state.get(tx.toIndex);

    validateSender(sender, tokenID, tx.amount, tx.fee);
    validateReceiver(receiver, tokenID);
    const senderKey = await storage.pubkey.get(sender.pubkeyID);
    if (tx.nonce != sender.nonce)
        throw new Error(`Bad nonce  tx ${tx.nonce}  state ${sender.nonce}`);
    if (!tx.signature) throw new Error("Expect tx to have signature here");
    if (!verifier.verify(tx.signature.sol, senderKey.pubkey, tx.message()))
        throw new Error("Invalid signature");
}

async function processTransfer(
    tx: TransferCompressedTx,
    tokenID: number,
    engine: StateStorageEngine
): Promise<void> {
    await processSender(tx.fromIndex, tokenID, tx.amount, tx.fee, engine);
    await processReceiver(tx.toIndex, tx.amount, tokenID, engine);
}

async function process(
    commitment: TransferCommitment,
    storageManager: StorageManager,
    params: DeploymentParameters
): Promise<void> {
    const txs = commitment.decompressTxs();

    const feeReceiverID = Number(commitment.feeReceiver);
    const engine = storageManager.state;
    const tokenID = (await engine.get(txs[0].fromIndex)).tokenID;
    if (txs.length > params.MAX_TXS_PER_COMMIT) throw new Error("Too many tx");
    for (const tx of txs) {
        await processTransfer(tx, tokenID, engine);
    }
    const fees = sum(txs.map(tx => tx.fee));
    await processReceiver(feeReceiverID, fees, tokenID, engine);
    await engine.commit();
    if (engine.root != commitment.stateRoot)
        throw new Error(
            `Validation failed  expect ${engine.root} got ${commitment.stateRoot}`
        );
}

export interface TransferPipe {
    source: AsyncGenerator<TransferOffchainTx>;
    tokenID: number;
    feeReceiverID: number;
}

async function pack(
    pipe: TransferPipe,
    storageManager: StorageManager,
    params: DeploymentParameters,
    verifier: BlsVerifier
): Promise<TransferCommitment> {
    const engine = storageManager.state;
    const acceptedTxs = [];
    const tokenID = pipe.tokenID;

    for await (const tx of pipe.source) {
        if (acceptedTxs.length >= params.MAX_TXS_PER_COMMIT) break;
        try {
            await validateTransferStateTransition(
                tx,
                tokenID,
                storageManager,
                verifier
            );
        } catch (e) {
            console.error(`bad tx ${tx}  ${e}`);
            continue;
        }
        await processTransfer(tx, pipe.tokenID, engine);
        acceptedTxs.push(tx);
    }
    if (acceptedTxs.length == 0) throw new Error("No tx has been accepted");
    const fees = sum(acceptedTxs.map(tx => tx.fee));
    await processReceiver(pipe.feeReceiverID, fees, pipe.tokenID, engine);
    await engine.commit();
    return TransferCommitment.fromTxs(
        acceptedTxs,
        engine.root,
        storageManager.pubkey.root,
        pipe.feeReceiverID
    );
}

export class OffchainTransferFactory {
    constructor(
        public readonly group: Group,
        public readonly engine: StateStorageEngine
    ) {}
    async *genTx(): AsyncGenerator<TransferOffchainTx> {
        while (true) {
            for (const sender of this.group.userIterator()) {
                const { user: receiver } = this.group.pickRandom();
                const senderState = await this.engine.get(sender.stateID);
                const amount = float16.round(senderState.balance.div(10));
                const fee = float16.round(amount.div(10));
                const tx = new TransferOffchainTx(
                    sender.stateID,
                    receiver.stateID,
                    amount,
                    fee,
                    senderState.nonce
                );
                tx.signature = sender.signRaw(tx.message());
                yield tx;
            }
        }
    }
}

export class TransferHandlingStrategy implements BatchHandlingStrategy {
    constructor(
        private rollup: Rollup,
        private storageManager: StorageManager,
        private params: DeploymentParameters
    ) {}
    async parseBatch(event: Event) {
        const ethTx = await event.getTransaction();
        const data = ethTx?.data as string;
        const accountRoot = event.args?.accountRoot;
        const txDescription = this.rollup.interface.parseTransaction({ data });
        const {
            stateRoots,
            signatures,
            feeReceivers,
            txss
        } = txDescription.args;
        const commitments = [];
        for (let i = 0; i < stateRoots.length; i++) {
            const commitment = new TransferCommitment(
                stateRoots[i],
                accountRoot,
                signatures[i],
                feeReceivers[i],
                txss[i]
            );
            commitments.push(commitment);
        }
        return new ConcreteBatch(commitments);
    }

    async processBatch(batch: ConcreteBatch<TransferCommitment>) {
        for (const commitment of batch.commitments) {
            await process(commitment, this.storageManager, this.params);
        }
    }
}

export interface ITransferPool {
    isEmpty(): boolean;
    getNextPipe(): TransferPipe;
}

export class TransferPool implements ITransferPool {
    private pool: SameTokenPool<TransferOffchainTx>;
    constructor(
        public readonly tokenID: number,
        public readonly feeReceiverID: number
    ) {
        this.pool = new SameTokenPool(1024);
    }
    push(tx: TransferOffchainTx) {
        this.pool.push(tx);
    }

    async *genTx(): AsyncGenerator<TransferOffchainTx> {
        while (this.pool.size > 0) {
            yield this.pool.pop();
        }
    }
    isEmpty() {
        return this.pool.size == 0;
    }

    getNextPipe() {
        const source = this.genTx();
        return {
            source,
            tokenID: this.tokenID,
            feeReceiverID: this.feeReceiverID
        };
    }
    toString() {
        return `<TransferPool  size ${this.pool.size}>`;
    }
}

export class SimulatorPool extends OffchainTransferFactory
    implements ITransferPool {
    private tokenID?: number;
    private feeReceiverID?: number;
    async setTokenID() {
        const stateID = this.group.getUser(0).stateID;
        const state = await this.engine.get(stateID);
        this.tokenID = state.tokenID;
        this.feeReceiverID = stateID;
    }

    isEmpty() {
        return false;
    }

    getNextPipe() {
        const source = this.genTx();
        if (this.tokenID === undefined) throw new Error("tokenID not set");
        if (this.feeReceiverID === undefined)
            throw new Error("feeReceiver not set");
        return {
            source,
            tokenID: this.tokenID,
            feeReceiverID: this.feeReceiverID
        };
    }
}

const MAX_COMMIT_PER_BATCH = 32;

async function packBatch(
    pool: ITransferPool,
    storageManager: StorageManager,
    params: DeploymentParameters,
    verifier: BlsVerifier
) {
    const commitments = [];
    for (let i = 0; i < MAX_COMMIT_PER_BATCH; i++) {
        const pipe = pool.getNextPipe();
        try {
            const commitment = await pack(
                pipe,
                storageManager,
                params,
                verifier
            );
            commitments.push(commitment);
        } catch (err) {
            continue;
        }
    }
    if (commitments.length == 0) throw new Error("The batch has no commitment");
    return new ConcreteBatch(commitments);
}

async function submitTransfer(
    batch: ConcreteBatch<TransferCommitment>,
    rollup: Rollup,
    stakingAmount: BigNumberish
) {
    return await rollup.submitTransfer(
        batch.commitments.map(c => c.stateRoot),
        batch.commitments.map(c => c.signature),
        batch.commitments.map(c => c.feeReceiver),
        batch.commitments.map(c => c.txs),
        { value: stakingAmount }
    );
}

export class TransferPackingCommand implements BatchPackingCommand {
    constructor(
        private params: DeploymentParameters,
        private storageManager: StorageManager,
        private pool: ITransferPool,
        private rollup: Rollup,
        private verifier: BlsVerifier
    ) {}

    async packAndSubmit(): Promise<ContractTransaction> {
        const batch = await packBatch(
            this.pool,
            this.storageManager,
            this.params,
            this.verifier
        );
        console.info("submitting batch", batch.toString());
        return await submitTransfer(
            batch,
            this.rollup,
            this.params.STAKE_AMOUNT
        );
    }
}
