// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {MonadNFT} from "../src/MonadNFT.sol";

/// @notice Deploy MonadNFT to the Monad testnet (chainId 10143).
/// @dev  forge script script/Deploy.s.sol:Deploy --rpc-url $MONAD_RPC_URL --broadcast
contract Deploy is Script {
    function run() external returns (MonadNFT) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        string memory name = "Monad NFT";
        string memory symbol = "MNFT";
        string memory baseURI = vm.envOr("BASE_URI", string("ipfs://REPLACE_WITH_CID/"));

        vm.startBroadcast(pk);
        MonadNFT nft = new MonadNFT(name, symbol, baseURI);
        vm.stopBroadcast();

        console2.log("MonadNFT deployed at:", address(nft));
        return nft;
    }
}
