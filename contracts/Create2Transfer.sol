pragma solidity ^0.5.15;
pragma experimental ABIEncoderV2;
import { FraudProofHelpers } from "./FraudProof.sol";
import { Types } from "./libs/Types.sol";
import { RollupUtilsLib } from "./libs/RollupUtils.sol";
import { MerkleTreeUtilsLib } from "./MerkleTreeUtils.sol";
import { BLS } from "./libs/BLS.sol";
import { Tx } from "./libs/Tx.sol";
import { MerkleTreeUtilsLib } from "./MerkleTreeUtils.sol";

contract Create2Transfer is FraudProofHelpers {
    using Tx for bytes;

    function checkSignature(
        uint256[2] memory signature,
        Types.SignatureProof memory proof,
        bytes32 stateRoot,
        bytes32 accountRoot,
        bytes32 domain,
        bytes memory txs
    ) public view returns (Types.ErrorCode) {
        uint256 batchSize = txs.create2Transfer_size();
        uint256[2][] memory messages = new uint256[2][](batchSize);
        for (uint256 i = 0; i < batchSize; i += 2) {
            Tx.Create2Transfer memory _tx = txs.create2Transfer_decode(i);
            // check state inclustion
            require(
                MerkleTreeUtilsLib.verifyLeaf(
                    stateRoot,
                    RollupUtilsLib.HashFromAccount(proof.stateAccounts[i]),
                    _tx.fromIndex,
                    proof.stateWitnesses[i]
                ),
                "Rollup: state inclusion signer"
            );

            // check pubkey inclusion
            require(
                MerkleTreeUtilsLib.verifyLeaf(
                    accountRoot,
                    keccak256(abi.encodePacked(proof.pubkeys[i])),
                    proof.stateAccounts[i].ID,
                    proof.pubkeyWitnesses[i]
                ),
                "Rollup: account does not exists"
            );

            require(
                MerkleTreeUtilsLib.verifyLeaf(
                    accountRoot,
                    keccak256(abi.encodePacked(proof.pubkeys[i + 1])),
                    _tx.toAccID,
                    proof.pubkeyWitnesses[i + 1]
                ),
                "Rollup: account does not exists"
            );

            // construct the message
            require(proof.stateAccounts[i].nonce > 0, "Rollup: zero nonce");

            bytes memory txMsg = txs.create2Transfer_messageOf(
                i,
                proof.stateAccounts[i].nonce - 1,
                proof.pubkeys[i],
                proof.pubkeys[i + 1]
            );

            // make the message
            messages[i] = BLS.hashToPoint(domain, txMsg);
        }
        if (!BLS.verifyMultiple(signature, proof.pubkeys, messages)) {
            return Types.ErrorCode.BadSignature;
        }
        return Types.ErrorCode.NoError;
    }

    /**
     * @notice processes the state transition of a commitment
     * @return updatedRoot, txRoot and if the batch is valid or not
     * */
    function processCreate2TransferCommit(
        bytes32 stateRoot,
        bytes memory txs,
        Types.AccountMerkleProof[] memory accountProofs,
        uint256 tokenType,
        uint256 feeReceiver
    ) public pure returns (bytes32, bool) {
        uint256 length = txs.create2Transfer_size();

        bool isTxValid;
        uint256 fees;
        Tx.Create2Transfer memory _tx;

        for (uint256 i = 0; i < length; i++) {
            // call process tx update for every transaction to check if any
            // tx evaluates correctly
            _tx = txs.create2Transfer_decode(i);
            fees = fees.add(_tx.fee);
            (stateRoot, , , , isTxValid) = processTx(
                stateRoot,
                _tx,
                tokenType,
                accountProofs[i * 2],
                accountProofs[i * 2 + 1]
            );
            if (!isTxValid) {
                break;
            }
        }
        if (isTxValid) {
            (stateRoot, , isTxValid) = processFee(
                stateRoot,
                fees,
                tokenType,
                feeReceiver,
                accountProofs[length * 2]
            );
        }

        return (stateRoot, !isTxValid);
    }

    /**
     * @notice processTx processes a transactions and returns the updated balance tree
     *  and the updated leaves
     * conditions in require mean that the dispute be declared invalid
     * if conditons evaluate if the coordinator was at fault
     * @return Total number of batches submitted onchain
     */
    function processTx(
        bytes32 stateRoot,
        Tx.Create2Transfer memory _tx,
        uint256 tokenType,
        Types.AccountMerkleProof memory fromAccountProof,
        Types.AccountMerkleProof memory toAccountProof
    )
        public
        pure
        returns (
            bytes32,
            bytes memory,
            bytes memory,
            Types.ErrorCode,
            bool
        )
    {
        require(
            MerkleTreeUtilsLib.verifyLeaf(
                stateRoot,
                RollupUtilsLib.HashFromAccount(fromAccountProof.account),
                _tx.fromIndex,
                fromAccountProof.siblings
            ),
            "Transfer: sender does not exist"
        );

        Types.ErrorCode err_code = validateTxBasic(
            _tx.amount,
            _tx.fee,
            fromAccountProof.account
        );
        if (err_code != Types.ErrorCode.NoError)
            return (ZERO_BYTES32, "", "", err_code, false);

        if (fromAccountProof.account.tokenType != tokenType) {
            return (
                ZERO_BYTES32,
                "",
                "",
                Types.ErrorCode.BadFromTokenType,
                false
            );
        }

        if (toAccountProof.account.tokenType != tokenType)
            return (
                ZERO_BYTES32,
                "",
                "",
                Types.ErrorCode.BadToTokenType,
                false
            );

        bytes32 newRoot;
        bytes memory new_from_account;
        bytes memory new_to_account;

        (new_from_account, newRoot) = ApplyTransferTxSender(
            fromAccountProof,
            _tx
        );

        // Validate we are creating on a zero account
        require(
            MerkleTreeUtilsLib.verifyLeaf(
                stateRoot,
                keccak256(abi.encode(0)),
                _tx.toIndex,
                toAccountProof.siblings
            ),
            "Transfer: receiver proof invalid"
        );

        (new_to_account, newRoot) = ApplyTransferTxReceiver(
            toAccountProof,
            _tx,
            fromAccountProof.account.tokenType
        );

        return (
            newRoot,
            new_from_account,
            new_to_account,
            Types.ErrorCode.NoError,
            true
        );
    }

    function ApplyTransferTxSender(
        Types.AccountMerkleProof memory _merkle_proof,
        Tx.Create2Transfer memory _tx
    ) public pure returns (bytes memory updatedAccount, bytes32 newRoot) {
        Types.UserAccount memory account = _merkle_proof.account;
        account.balance = account.balance.sub(_tx.amount).sub(_tx.fee);
        account.nonce++;
        bytes memory accountInBytes = RollupUtilsLib.BytesFromAccount(account);
        newRoot = MerkleTreeUtilsLib.rootFromWitnesses(
            keccak256(accountInBytes),
            _tx.fromIndex,
            _merkle_proof.siblings
        );
        return (accountInBytes, newRoot);
    }

    function ApplyTransferTxReceiver(
        Types.AccountMerkleProof memory _merkle_proof,
        Tx.Create2Transfer memory _tx,
        uint256 token
    ) public pure returns (bytes memory updatedAccount, bytes32 newRoot) {
        // Initialize account
        // TODO create new account from scratch
        _merkle_proof.account.ID = _tx.toAccID;
        _merkle_proof.account.balance = _tx.amount;
        _merkle_proof.account.tokenType = token;
        bytes memory accountInBytes = RollupUtilsLib.BytesFromAccount(
            _merkle_proof.account
        );
        newRoot = MerkleTreeUtilsLib.rootFromWitnesses(
            keccak256(accountInBytes),
            _tx.toIndex,
            _merkle_proof.siblings
        );
        return (accountInBytes, newRoot);
    }

    function processFee(
        bytes32 stateRoot,
        uint256 fees,
        uint256 tokenType,
        uint256 feeReceiver,
        Types.AccountMerkleProof memory stateLeafProof
    )
        public
        pure
        returns (
            bytes32 newRoot,
            Types.ErrorCode err,
            bool isValid
        )
    {
        Types.UserAccount memory account = stateLeafProof.account;
        if (account.tokenType != tokenType) {
            return (ZERO_BYTES32, Types.ErrorCode.BadToTokenType, false);
        }
        require(
            MerkleTreeUtilsLib.verifyLeaf(
                stateRoot,
                RollupUtilsLib.HashFromAccount(account),
                feeReceiver,
                stateLeafProof.siblings
            ),
            "Transfer: fee receiver does not exist"
        );
        account.balance = account.balance.add(fees);
        newRoot = UpdateAccountWithSiblings(account, stateLeafProof);
        return (newRoot, Types.ErrorCode.NoError, true);
    }
}
