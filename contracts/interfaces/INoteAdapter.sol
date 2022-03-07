// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface INoteAdapter {
    /* Structures */
    struct LoanInfo {
        address borrower;
        uint256 principal;
        uint256 repayment;
        uint64 maturity;
        uint64 duration;
        address currencyToken;
        address collateralToken;
        uint256 collateralTokenId;
    }

    /* Primary API */
    function noteToken() external view returns (IERC721);

    function lendingPlatform() external view returns (address);

    function getLoanInfo(uint256 noteTokenId) external view returns (LoanInfo memory);

    function getLiquidateCalldata(uint256 noteTokenId) external view returns (bytes memory);

    function isSupported(uint256 noteTokenId, address currencyToken) external view returns (bool);

    function isComplete(uint256 noteTokenId) external view returns (bool);
}
