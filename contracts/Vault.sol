// SPDX-License-Identifier: MIT
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;
import { Bitmap } from "./libs/Bitmap.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Rollup } from "./rollup/Rollup.sol";
import { ITokenRegistry } from "./TokenRegistry.sol";
import { Types } from "./libs/Types.sol";
import { MerkleTree } from "./libs/MerkleTree.sol";
import { SpokeRegistry } from "./SpokeRegistry.sol";

contract Vault {
    using Types for Types.MassMigrationCommitment;
    using Types for Types.Batch;

    // Can't be immutable yet. Since the rollup is deployed after Vault
    Rollup public rollup;
    SpokeRegistry public immutable spokes;
    ITokenRegistry public immutable tokenRegistry;

    mapping(uint256 => uint256) private bitmap;

    constructor(ITokenRegistry _tokenRegistry, SpokeRegistry _spokes) public {
        tokenRegistry = _tokenRegistry;
        spokes = _spokes;
    }

    /**
    @dev We assume Vault is deployed before Rollup
     */
    function setRollupAddress(Rollup _rollup) external {
        rollup = _rollup;
    }

    function isBatchApproved(uint256 batchID) public view returns (bool) {
        return Bitmap.isClaimed(batchID, bitmap);
    }

    function requestApproval(
        uint256 batchID,
        Types.MMCommitmentInclusionProof memory commitmentMP
    ) public {
        require(
            msg.sender ==
                spokes.getSpokeAddress(commitmentMP.commitment.body.spokeID),
            "Vault: msg.sender should be the target spoke"
        );
        Types.Batch memory batch = rollup.getBatch(batchID);

        require(
            block.number >= batch.finaliseOn(),
            "Vault: Batch shoould be finalised"
        );

        require(
            MerkleTree.verify(
                batch.commitmentRoot,
                commitmentMP.commitment.toHash(),
                commitmentMP.path,
                commitmentMP.witness
            ),
            "Vault: Commitment is not present in batch"
        );
        (address addr, uint256 l2Unit) =
            tokenRegistry.safeGetRecord(commitmentMP.commitment.body.tokenID);
        Bitmap.setClaimed(batchID, bitmap);
        uint256 l1Amount = commitmentMP.commitment.body.amount * l2Unit;
        require(
            IERC20(addr).approve(msg.sender, l1Amount),
            "Vault: Token approval failed"
        );
    }
}
