// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

/// @title MonadNFT
/// @notice Example ERC-721 minting contract for Monad. Built on OpenZeppelin
///         (per the monskills scaffold rule: never build token contracts from
///         scratch). Monad is fully EVM-compatible, so OZ contracts deploy
///         unchanged — only the RPC endpoint / chainId differ.
contract MonadNFT is ERC721, Ownable {
    uint256 private _nextId;
    string private _baseTokenURI;

    constructor(string memory name_, string memory symbol_, string memory baseURI_)
        ERC721(name_, symbol_)
        Ownable(msg.sender)
    {
        _baseTokenURI = baseURI_;
    }

    /// @notice Mint the next token to `to`. Owner-only (demo).
    function mint(address to) external onlyOwner returns (uint256) {
        uint256 id = _nextId++;
        _safeMint(to, id);
        return id;
    }

    function totalMinted() external view returns (uint256) {
        return _nextId;
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }
}
