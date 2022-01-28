// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.9;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./TestNoteToken.sol";

contract TestLendingPlatform is Ownable, IERC165, IERC721Receiver {
    using SafeERC20 for IERC20;

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    event LoanCreated(uint256 loanId, address borrower, address lender);
    event LoanRepaid(uint256 loanId);
    event LoanLiquidated(uint256 loanId);

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    struct LoanTerms {
        address borrower;
        uint256 principal;
        uint256 repayment;
        uint64 startTime;
        uint32 duration;
        address collateralToken;
        uint256 collateralTokenId;
    }

    IERC20 public immutable currencyToken;
    TestNoteToken public immutable noteToken;
    mapping(uint256 => LoanTerms) public loans;
    mapping(uint256 => bool) public loansComplete;

    uint256 private _loanId;

    constructor(IERC20 currencyToken_) {
        currencyToken = currencyToken_;
        noteToken = new TestNoteToken();
    }

    /**************************************************************************/
    /* Primary API */
    /**************************************************************************/

    function lend(
        address borrower,
        address lender,
        IERC721 collateralToken,
        uint256 collateralTokenId,
        uint256 principal,
        uint256 repayment,
        uint32 duration
    ) public {
        require(repayment >= principal, "Repayment less than principal");

        uint256 loanId = _loanId++;

        LoanTerms storage loan = loans[loanId];
        loan.borrower = borrower;
        loan.principal = principal;
        loan.repayment = repayment;
        loan.startTime = uint64(block.timestamp);
        loan.duration = duration;
        loan.collateralToken = address(collateralToken);
        loan.collateralTokenId = collateralTokenId;

        collateralToken.safeTransferFrom(borrower, address(this), collateralTokenId);
        currencyToken.safeTransferFrom(lender, borrower, principal);
        noteToken.mint(lender, loanId);

        emit LoanCreated(loanId, borrower, lender);
    }

    function repay(uint256 loanId) public {
        LoanTerms storage loan = loans[loanId];

        require(loan.borrower != address(0x0), "Unknown loan");
        require(loan.borrower == msg.sender, "Invalid caller");

        loansComplete[loanId] = true;

        currencyToken.safeTransferFrom(loan.borrower, noteToken.ownerOf(loanId), loan.repayment);
        IERC721(loan.collateralToken).safeTransferFrom(address(this), loan.borrower, loan.collateralTokenId);
        noteToken.burn(loanId);

        emit LoanRepaid(loanId);

        delete loans[loanId];
    }

    function liquidate(uint256 loanId) public {
        LoanTerms storage loan = loans[loanId];

        require(loan.borrower != address(0x0), "Unknown loan");
        require(block.timestamp > loan.startTime + loan.duration, "Loan not expired");

        loansComplete[loanId] = true;

        IERC721(loan.collateralToken).safeTransferFrom(
            address(this),
            noteToken.ownerOf(loanId),
            loan.collateralTokenId
        );
        noteToken.burn(loanId);

        emit LoanLiquidated(loanId);

        delete loans[loanId];
    }

    /******************************************************/
    /* ERC165 interface */
    /******************************************************/

    bytes4 private constant _INTERFACE_ID_ERC165 = 0x01ffc9a7;

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return (interfaceId == _INTERFACE_ID_ERC165) || (interfaceId == IERC721Receiver.onERC721Received.selector);
    }

    /******************************************************/
    /* Receiver Hooks */
    /******************************************************/

    function onERC721Received(
        address, /* operator */
        address, /* from */
        uint256, /* tokenId */
        bytes calldata /* data */
    ) external pure override returns (bytes4) {
        return this.onERC721Received.selector;
    }
}