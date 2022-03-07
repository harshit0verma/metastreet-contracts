// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "./ILoanPriceOracle.sol";
import "./INoteAdapter.sol";
import "./ILoanReceiver.sol";

interface IVault is ILoanReceiver {
    /* Tranche identifier */
    enum TrancheId {
        Senior,
        Junior
    }

    /* Getters */
    function name() external view returns (string memory);

    function currencyToken() external view returns (IERC20);

    function lpToken(TrancheId trancheId) external view returns (IERC20);

    function loanPriceOracle() external view returns (ILoanPriceOracle);

    function collateralLiquidator() external view returns (address);

    function noteAdapters(address noteToken) external view returns (INoteAdapter);

    function sharePrice(TrancheId trancheId) external view returns (uint256);

    function redemptionSharePrice(TrancheId trancheId) external view returns (uint256);

    function utilization() external view returns (uint256);

    /* User API */
    function deposit(TrancheId trancheId, uint256 amount) external;

    function sellNote(
        IERC721 noteToken,
        uint256 noteTokenId,
        uint256 minPurchasePrice
    ) external;

    function sellNoteAndDeposit(
        IERC721 noteToken,
        uint256 noteTokenId,
        uint256[2] calldata amounts
    ) external;

    function redeem(TrancheId trancheId, uint256 shares) external;

    function withdraw(TrancheId trancheId, uint256 amount) external;

    /* Liquidation API */
    function liquidateLoan(IERC721 noteToken, uint256 noteTokenId) external;

    function withdrawCollateral(IERC721 noteToken, uint256 noteTokenId) external;

    /* Callbacks */

    function onCollateralLiquidated(
        address noteToken,
        uint256 noteTokenId,
        uint256 proceeds
    ) external;

    /* Events */
    event Deposited(address indexed account, TrancheId indexed trancheId, uint256 amount, uint256 shares);
    event NotePurchased(address indexed account, address noteToken, uint256 noteTokenId, uint256 purchasePrice);
    event Redeemed(address indexed account, TrancheId indexed trancheId, uint256 shares, uint256 amount);
    event Withdrawn(address indexed account, TrancheId indexed trancheId, uint256 amount);
    event CollateralWithdrawn(
        address noteToken,
        uint256 noteTokenId,
        address collateralToken,
        uint256 collateralTokenId,
        address collateralLiquidator
    );

    event LoanRepaid(address noteToken, uint256 noteTokenId, uint256[2] trancheReturns);
    event LoanLiquidated(address noteToken, uint256 noteTokenId, uint256[2] trancheLosses);
    event CollateralLiquidated(address noteToken, uint256 noteTokenId, uint256 proceeds);

}
