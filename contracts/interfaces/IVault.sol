// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "./ILoanPriceOracle.sol";

interface IVault {
    /* Getters */
    function name() external view returns (string memory);
    function currencyToken() external view returns (IERC20);
    function seniorLPToken() external view returns (IERC20);
    function juniorLPToken() external view returns (IERC20);
    function loanPriceOracle() external view returns (ILoanPriceOracle);

    /* Primary API */
    function deposit(uint256[2] calldata amounts) external;
    function sellNote(IERC721 noteToken, uint256 tokenId, uint256 purchasePrice) external;
    function sellNoteAndDeposit(IERC721 noteToken, uint256 tokenId, uint256[2] calldata amounts) external;
    function redeem(uint256[2] calldata shares) external;
    function withdraw(uint256[2] calldata amounts) external;

    /* Callbacks */
    function onLoanRepayment(IERC721 noteToken, uint256 tokenId) external;
    function onLoanDefault(IERC721 noteToken, uint256 tokenId) external;
    function onLoanLiquidated(IERC721 noteToken, uint256 tokenId, uint256 proceeds) external;

    /* Setters */
    enum Tranche { Senior, Junior }
    function setTrancheRate(Tranche tranche, uint256 interestRate) external;
    function setLoanPriceOracle(address loanPriceOracle_) external;

    /* Events */
    event Deposited(address indexed account, uint256[2] amounts);
    event NotePurchased(address indexed account, address noteToken, uint256 tokenId,
                        uint256 purchasePrice);
    event Redeemed(address indexed account, uint256[2] shares, uint256[2] amounts);
    event Withdrawn(address indexed account, uint256[2] amounts);
    event TrancheRateUpdated(Tranche tranche, uint256 interestRate);
    event LoanPriceOracleUpdated(address loanPriceOracle);
}
