import { expect } from "chai";
import { ethers } from "hardhat";

import { BigNumber } from "@ethersproject/bignumber";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

import {
  TestERC20,
  TestERC721,
  TestLendingPlatform,
  TestNoteToken,
  TestNoteAdapter,
  LoanPriceOracle,
  Vault,
  LPToken,
} from "../typechain";

import { extractEvent } from "./helpers/EventUtilities";
import { initializeAccounts, createLoan, getBlockTimestamp, elapseTime } from "./helpers/VaultHelpers";
import { FixedPoint } from "./helpers/FixedPointHelpers";
import { DeterministicRandom } from "./helpers/RandomHelpers";
import {
  CollateralParameters,
  encodeCollateralParameters,
  computePiecewiseLinearModel,
} from "./helpers/LoanPriceOracleHelpers";

describe("Integration", function () {
  let accounts: SignerWithAddress[];
  let tok1: TestERC20;
  let nft1: TestERC721;
  let lendingPlatform: TestLendingPlatform;
  let noteToken: TestNoteToken;
  let loanPriceOracle: LoanPriceOracle;
  let testNoteAdapter: TestNoteAdapter;
  let vault: Vault;
  let seniorLPToken: LPToken;
  let juniorLPToken: LPToken;
  let lastBlockTimestamp: number;

  /* Account references */
  let accountBorrower: SignerWithAddress;
  let accountLender: SignerWithAddress;
  let accountDepositor: SignerWithAddress;
  let accountLiquidator: SignerWithAddress;

  /* LoanPriceOracle parameters */
  const minimumDiscountRate = FixedPoint.normalizeRate("0.05");

  const collateralParameters: CollateralParameters = {
    collateralValue: ethers.utils.parseEther("100"),
    aprUtilizationSensitivity: computePiecewiseLinearModel({
      minRate: FixedPoint.normalizeRate("0.05"),
      targetRate: FixedPoint.normalizeRate("0.10"),
      maxRate: FixedPoint.normalizeRate("2.00"),
      target: FixedPoint.from("0.90"),
      max: FixedPoint.from("1.00"),
    }),
    aprLoanToValueSensitivity: computePiecewiseLinearModel({
      minRate: FixedPoint.normalizeRate("0.05"),
      targetRate: FixedPoint.normalizeRate("0.10"),
      maxRate: FixedPoint.normalizeRate("2.00"),
      target: FixedPoint.from("0.30"),
      max: FixedPoint.from("0.60"),
    }),
    aprDurationSensitivity: computePiecewiseLinearModel({
      minRate: FixedPoint.normalizeRate("0.05"),
      targetRate: FixedPoint.normalizeRate("0.10"),
      maxRate: FixedPoint.normalizeRate("2.00"),
      target: FixedPoint.from(30 * 86400),
      max: FixedPoint.from(90 * 86400),
    }),
    sensitivityWeights: [50, 25, 25],
  };

  beforeEach("deploy fixture", async () => {
    accounts = await ethers.getSigners();

    const testERC20Factory = await ethers.getContractFactory("TestERC20");
    const testERC721Factory = await ethers.getContractFactory("TestERC721");
    const testLendingPlatformFactory = await ethers.getContractFactory("TestLendingPlatform");
    const testNoteAdapterFactory = await ethers.getContractFactory("TestNoteAdapter");
    const loanPriceOracleFactory = await ethers.getContractFactory("LoanPriceOracle");
    const lpTokenFactory = await ethers.getContractFactory("LPToken");
    const vaultFactory = await ethers.getContractFactory("Vault");

    /* Deploy test token */
    tok1 = (await testERC20Factory.deploy("WETH", "WETH", ethers.utils.parseEther("1000000"))) as TestERC20;
    await tok1.deployed();

    /* Deploy test NFT */
    nft1 = (await testERC721Factory.deploy("NFT 1", "NFT1", "https://nft1.com/token/")) as TestERC721;
    await nft1.deployed();

    /* Deploy lending platform */
    lendingPlatform = (await testLendingPlatformFactory.deploy(tok1.address)) as TestLendingPlatform;
    await lendingPlatform.deployed();

    /* Get lending platform's note token */
    noteToken = (await ethers.getContractAt(
      "TestNoteToken",
      await lendingPlatform.noteToken(),
      accounts[0]
    )) as TestNoteToken;

    /* Deploy test note adapter */
    testNoteAdapter = (await testNoteAdapterFactory.deploy(lendingPlatform.address)) as TestNoteAdapter;
    await testNoteAdapter.deployed();

    /* Deploy loan price oracle */
    loanPriceOracle = (await loanPriceOracleFactory.deploy(tok1.address)) as LoanPriceOracle;
    await loanPriceOracle.deployed();

    /* Deploy Senior LP token */
    seniorLPToken = (await lpTokenFactory.deploy()) as LPToken;
    await seniorLPToken.deployed();
    await seniorLPToken.initialize("Senior LP Token", "msLP-TEST-WETH");

    /* Deploy Junior LP token */
    juniorLPToken = (await lpTokenFactory.deploy()) as LPToken;
    await juniorLPToken.deployed();
    await juniorLPToken.initialize("Junior LP Token", "mjLP-TEST-WETH");

    /* Deploy vault */
    vault = (await vaultFactory.deploy()) as Vault;
    await vault.deployed();
    await vault.initialize(
      "Test Vault",
      tok1.address,
      loanPriceOracle.address,
      seniorLPToken.address,
      juniorLPToken.address
    );

    /* Transfer ownership of LP tokens to Vault */
    await seniorLPToken.transferOwnership(vault.address);
    await juniorLPToken.transferOwnership(vault.address);

    /* Setup loan price oracle */
    await loanPriceOracle.setMinimumDiscountRate(minimumDiscountRate);
    await loanPriceOracle.setCollateralParameters(nft1.address, encodeCollateralParameters(collateralParameters));

    /* Setup vault */
    await vault.setNoteAdapter(noteToken.address, testNoteAdapter.address);
    await vault.setSeniorTrancheRate(FixedPoint.normalizeRate("0.05"));
    await vault.setReserveRatio(FixedPoint.from("0.10"));
    await vault.setCollateralLiquidator(accounts[6].address);

    /* Setup accounts */
    accountBorrower = accounts[1];
    accountLender = accounts[2];
    accountDepositor = accounts[4];
    accountLiquidator = accounts[6];

    await initializeAccounts(
      accountBorrower,
      accountLender,
      accountDepositor,
      accountLiquidator,
      nft1,
      tok1,
      lendingPlatform,
      vault
    );

    lastBlockTimestamp = (await ethers.provider.getBlock(await ethers.provider.getBlockNumber())).timestamp;
  });

  describe("single loan", async function () {
    it("tests loan repayment", async function () {
      const depositAmounts = [ethers.utils.parseEther("10"), ethers.utils.parseEther("5")];
      const principal = ethers.utils.parseEther("10.0");
      const repayment = ethers.utils.parseEther("10.1");
      const duration = 30 * 86400;
      const maturity = lastBlockTimestamp + duration;

      /* Deposit cash */
      await vault.connect(accountDepositor).deposit(0, depositAmounts[0]);
      await vault.connect(accountDepositor).deposit(1, depositAmounts[1]);

      /* Create loan */
      const loanId = await createLoan(
        lendingPlatform,
        nft1,
        accountBorrower,
        accountLender,
        principal,
        repayment,
        duration
      );

      /* Check vault deposit value and share price before */
      expect((await vault.trancheState(0)).depositValue).to.equal(depositAmounts[0]);
      expect((await vault.trancheState(1)).depositValue).to.equal(depositAmounts[1]);
      expect(await vault.sharePrice(0)).to.equal(FixedPoint.from("1"));
      expect(await vault.sharePrice(1)).to.equal(FixedPoint.from("1"));
      expect(await vault.redemptionSharePrice(0)).to.equal(FixedPoint.from("1"));
      expect(await vault.redemptionSharePrice(1)).to.equal(FixedPoint.from("1"));

      /* Calculate loan price */
      const purchasePrice = await loanPriceOracle.priceLoan(
        nft1.address,
        1234,
        principal,
        repayment,
        duration,
        maturity,
        await vault.utilization()
      );

      /* Add margin for min purchase price */
      const minPurchasePrice = purchasePrice.sub(ethers.utils.parseEther("0.01"));

      /* Sell note to vault */
      const sellTx = await vault
        .connect(accountLender)
        .sellNote(await lendingPlatform.noteToken(), loanId, minPurchasePrice);
      const actualPurchasePrice = (await extractEvent(sellTx, vault, "NotePurchased")).args.purchasePrice;

      /* Check vault deposit value and share price after sale */
      expect((await vault.trancheState(0)).depositValue).to.equal(depositAmounts[0]);
      expect((await vault.trancheState(1)).depositValue).to.equal(depositAmounts[1]);
      expect(await vault.sharePrice(0)).to.be.gt(FixedPoint.from("1"));
      expect(await vault.sharePrice(1)).to.be.gt(FixedPoint.from("1"));
      expect(await vault.redemptionSharePrice(0)).to.equal(FixedPoint.from("1"));
      expect(await vault.redemptionSharePrice(1)).to.equal(FixedPoint.from("1"));

      /* Repay at 29 days */
      await elapseTime(duration - 86400);

      /* Repay loan */
      await lendingPlatform.connect(accountBorrower).repay(loanId, false);

      /* Callback vault */
      await vault.onLoanRepaid(await lendingPlatform.noteToken(), loanId);

      /* Check vault deposit value and share price after repayment */
      expect((await vault.balanceState()).totalCashBalance).to.equal(
        depositAmounts[0].add(depositAmounts[1]).add(repayment.sub(actualPurchasePrice))
      );
      expect((await vault.trancheState(0)).depositValue).to.equal(ethers.utils.parseEther("10.027520456942945852"));
      expect((await vault.trancheState(1)).depositValue).to.equal(ethers.utils.parseEther("5.027508882314796534"));
      expect(await vault.sharePrice(0)).to.equal(FixedPoint.from("1.002752045694294585"));
      expect(await vault.sharePrice(1)).to.equal(FixedPoint.from("1.005501776462959306"));
      expect(await vault.redemptionSharePrice(0)).to.equal(await vault.sharePrice(0));
      expect(await vault.redemptionSharePrice(1)).to.equal(await vault.sharePrice(1));
    });
    it("tests loan default with higher liquidation", async function () {
      const depositAmounts = [ethers.utils.parseEther("10"), ethers.utils.parseEther("5")];
      const principal = ethers.utils.parseEther("10.0");
      const repayment = ethers.utils.parseEther("10.1");
      const duration = 30 * 86400;
      const maturity = lastBlockTimestamp + duration;
      const liquidation = ethers.utils.parseEther("20");

      /* Deposit cash */
      await vault.connect(accountDepositor).deposit(0, depositAmounts[0]);
      await vault.connect(accountDepositor).deposit(1, depositAmounts[1]);

      /* Create loan */
      const loanId = await createLoan(
        lendingPlatform,
        nft1,
        accountBorrower,
        accountLender,
        principal,
        repayment,
        duration
      );

      /* Check vault deposit value and share price before */
      expect((await vault.trancheState(0)).depositValue).to.equal(depositAmounts[0]);
      expect((await vault.trancheState(1)).depositValue).to.equal(depositAmounts[1]);
      expect(await vault.sharePrice(0)).to.equal(FixedPoint.from("1"));
      expect(await vault.sharePrice(1)).to.equal(FixedPoint.from("1"));
      expect(await vault.redemptionSharePrice(0)).to.equal(FixedPoint.from("1"));
      expect(await vault.redemptionSharePrice(1)).to.equal(FixedPoint.from("1"));

      /* Calculate loan price */
      const purchasePrice = await loanPriceOracle.priceLoan(
        nft1.address,
        1234,
        principal,
        repayment,
        duration,
        maturity,
        await vault.utilization()
      );

      /* Add margin for min purchase price */
      const minPurchasePrice = purchasePrice.sub(ethers.utils.parseEther("0.01"));

      /* Sell note to vault */
      const sellTx = await vault
        .connect(accountLender)
        .sellNote(await lendingPlatform.noteToken(), loanId, minPurchasePrice);
      const actualPurchasePrice = (await extractEvent(sellTx, vault, "NotePurchased")).args.purchasePrice;

      /* Check vault deposit value and share price after sale */
      expect((await vault.trancheState(0)).depositValue).to.equal(depositAmounts[0]);
      expect((await vault.trancheState(1)).depositValue).to.equal(depositAmounts[1]);
      expect(await vault.sharePrice(0)).to.be.gt(FixedPoint.from("1"));
      expect(await vault.sharePrice(1)).to.be.gt(FixedPoint.from("1"));
      expect(await vault.redemptionSharePrice(0)).to.equal(FixedPoint.from("1"));
      expect(await vault.redemptionSharePrice(1)).to.equal(FixedPoint.from("1"));

      /* Wait for loan to expire */
      await elapseTime(duration);

      /* Liquidate the loan */
      await lendingPlatform.liquidate(loanId);

      /* Callback vault */
      await vault.onLoanLiquidated(await lendingPlatform.noteToken(), loanId);

      /* Withdraw the collateral */
      await vault.connect(accountLiquidator).withdrawCollateral(noteToken.address, loanId);

      /* Callback vault */
      await vault.connect(accountLiquidator).onCollateralLiquidated(noteToken.address, loanId, liquidation);

      /* Check vault deposit value and share price after repayment */
      expect((await vault.balanceState()).totalCashBalance).to.equal(
        depositAmounts[0].add(depositAmounts[1]).add(liquidation.sub(actualPurchasePrice))
      );
      expect((await vault.trancheState(0)).depositValue).to.equal(ethers.utils.parseEther("10.027520456942945852"));
      expect((await vault.trancheState(1)).depositValue).to.equal(ethers.utils.parseEther("14.927508882314796534"));
      expect(await vault.sharePrice(0)).to.equal(FixedPoint.from("1.002752045694294585"));
      expect(await vault.sharePrice(1)).to.equal(FixedPoint.from("2.985501776462959306"));
      expect(await vault.redemptionSharePrice(0)).to.equal(await vault.sharePrice(0));
      expect(await vault.redemptionSharePrice(1)).to.equal(await vault.sharePrice(1));
    });
    it("tests loan default with lower liquidation", async function () {
      const depositAmounts = [ethers.utils.parseEther("10"), ethers.utils.parseEther("5")];
      const principal = ethers.utils.parseEther("10.0");
      const repayment = ethers.utils.parseEther("10.1");
      const duration = 30 * 86400;
      const maturity = lastBlockTimestamp + duration;
      const liquidation = ethers.utils.parseEther("7");

      /* Deposit cash */
      await vault.connect(accountDepositor).deposit(0, depositAmounts[0]);
      await vault.connect(accountDepositor).deposit(1, depositAmounts[1]);

      /* Create loan */
      const loanId = await createLoan(
        lendingPlatform,
        nft1,
        accountBorrower,
        accountLender,
        principal,
        repayment,
        duration
      );

      /* Check vault deposit value and share price before */
      expect((await vault.trancheState(0)).depositValue).to.equal(depositAmounts[0]);
      expect((await vault.trancheState(1)).depositValue).to.equal(depositAmounts[1]);
      expect(await vault.sharePrice(0)).to.equal(FixedPoint.from("1"));
      expect(await vault.sharePrice(1)).to.equal(FixedPoint.from("1"));
      expect(await vault.redemptionSharePrice(0)).to.equal(FixedPoint.from("1"));
      expect(await vault.redemptionSharePrice(1)).to.equal(FixedPoint.from("1"));

      /* Calculate loan price */
      const purchasePrice = await loanPriceOracle.priceLoan(
        nft1.address,
        1234,
        principal,
        repayment,
        duration,
        maturity,
        await vault.utilization()
      );

      /* Add margin for min purchase price */
      const minPurchasePrice = purchasePrice.sub(ethers.utils.parseEther("0.01"));

      /* Sell note to vault */
      const sellTx = await vault
        .connect(accountLender)
        .sellNote(await lendingPlatform.noteToken(), loanId, minPurchasePrice);
      const actualPurchasePrice = (await extractEvent(sellTx, vault, "NotePurchased")).args.purchasePrice;

      /* Check vault deposit value and share price after sale */
      expect((await vault.trancheState(0)).depositValue).to.equal(depositAmounts[0]);
      expect((await vault.trancheState(1)).depositValue).to.equal(depositAmounts[1]);
      expect(await vault.sharePrice(0)).to.be.gt(FixedPoint.from("1"));
      expect(await vault.sharePrice(1)).to.be.gt(FixedPoint.from("1"));
      expect(await vault.redemptionSharePrice(0)).to.equal(FixedPoint.from("1"));
      expect(await vault.redemptionSharePrice(1)).to.equal(FixedPoint.from("1"));

      /* Wait for loan to expire */
      await elapseTime(duration);

      /* Liquidate the loan */
      await lendingPlatform.liquidate(loanId);

      /* Callback vault */
      await vault.onLoanLiquidated(await lendingPlatform.noteToken(), loanId);

      /* Withdraw the collateral */
      await vault.connect(accountLiquidator).withdrawCollateral(noteToken.address, loanId);

      /* Callback vault */
      await vault.connect(accountLiquidator).onCollateralLiquidated(noteToken.address, loanId, liquidation);

      /* Check vault deposit value and share price after repayment */
      expect((await vault.balanceState()).totalCashBalance).to.equal(
        depositAmounts[0].add(depositAmounts[1]).sub(actualPurchasePrice.sub(liquidation))
      );
      expect((await vault.trancheState(0)).depositValue).to.equal(ethers.utils.parseEther("10.027520456942945852"));
      expect((await vault.trancheState(1)).depositValue).to.equal(ethers.utils.parseEther("1.927508882314796534"));
      expect(await vault.sharePrice(0)).to.equal(FixedPoint.from("1.002752045694294585"));
      expect(await vault.sharePrice(1)).to.equal(FixedPoint.from("0.385501776462959306"));
      expect(await vault.redemptionSharePrice(0)).to.equal(await vault.sharePrice(0));
      expect(await vault.redemptionSharePrice(1)).to.equal(await vault.sharePrice(1));
    });
  });

  describe("many loans", async function () {
    it("successfully processes random loans", async function () {
      interface LoanInfo {
        loanId: BigNumber;
        principal: BigNumber;
        repayment: BigNumber;
        purchasePrice: BigNumber;
        liquidation: BigNumber;
        duration: number;
        maturity: number;
      }

      /* Parameters */
      const depositAmounts = [ethers.utils.parseEther("10"), ethers.utils.parseEther("5")];
      const numTotalLoans = 50;
      const maxActiveLoans = 5;
      const defaultProbability = 0.15;
      const minLoanPrice = ethers.utils.parseEther("0.1");
      const targetUtilization = FixedPoint.from("0.90");

      /* Loan state and tracked balance */
      let activeLoans: LoanInfo[] = [];
      let numLoansProcessed = 0;
      let expectedCashBalance = depositAmounts[0].add(depositAmounts[1]);

      /* Deposit cash in Vault */
      await vault.connect(accountDepositor).deposit(0, depositAmounts[0]);
      await vault.connect(accountDepositor).deposit(1, depositAmounts[1]);

      /* Helper function to create a random loan */
      async function createRandomLoan(vaultCash: BigNumber): Promise<LoanInfo> {
        const repayment = await DeterministicRandom.randomBigNumberRange(minLoanPrice, vaultCash);
        const principal = FixedPoint.mul(repayment, FixedPoint.from("0.90"));
        const liquidation = await DeterministicRandom.randomBigNumberRange(
          FixedPoint.mul(principal, FixedPoint.from("0.80")),
          FixedPoint.mul(principal, FixedPoint.from("2.00"))
        );

        const duration = Math.floor(await DeterministicRandom.randomNumberRange(15 * 86400, 90 * 86400));
        const maturity = (await getBlockTimestamp()) + duration;

        /* Create loan */
        const loanId = await createLoan(
          lendingPlatform,
          nft1,
          accountBorrower,
          accountLender,
          principal,
          repayment,
          duration
        );

        return { loanId, principal, repayment, purchasePrice: ethers.constants.Zero, liquidation, duration, maturity };
      }

      while (numLoansProcessed < numTotalLoans || activeLoans.length > 0) {
        /* Get current vault utilization and cash availble */
        const utilization = await vault.utilization();
        const cashAvailable = (await vault.balanceState()).totalCashBalance.sub(await vault.reservesAvailable());

        if (
          numLoansProcessed < numTotalLoans &&
          activeLoans.length < maxActiveLoans &&
          utilization.lt(targetUtilization) &&
          cashAvailable.gt(minLoanPrice)
        ) {
          /* Create a random loan */
          const loan = await createRandomLoan(cashAvailable);

          /* Calculate loan price */
          const purchasePrice = await loanPriceOracle.priceLoan(
            nft1.address,
            1234,
            loan.principal,
            loan.repayment,
            loan.duration,
            loan.maturity,
            utilization
          );

          /* Sell note to vault */
          const sellTx = await vault
            .connect(accountLender)
            .sellNote(
              await lendingPlatform.noteToken(),
              loan.loanId,
              purchasePrice.sub(ethers.utils.parseEther("0.01"))
            );
          const actualPurchasePrice = (await extractEvent(sellTx, vault, "NotePurchased")).args.purchasePrice;

          /* Update purchase price */
          loan.purchasePrice = actualPurchasePrice;

          /* Add the loan */
          activeLoans.push(loan);

          /* Update balance */
          expectedCashBalance = expectedCashBalance.sub(loan.purchasePrice);
        }

        /* Advance a day */
        await elapseTime(86400);

        /* Check for expired loans */
        const currentTimestamp = await getBlockTimestamp();
        activeLoans.forEach(async (loan) => {
          if (loan.maturity > currentTimestamp) return;

          if ((await DeterministicRandom.randomNumber()) < defaultProbability) {
            /* Handle default */

            /* Liquidate the loan */
            await lendingPlatform.liquidate(loan.loanId);

            /* Callback vault */
            await vault.onLoanLiquidated(await lendingPlatform.noteToken(), loan.loanId);

            /* Withdraw the collateral */
            await vault.connect(accountLiquidator).withdrawCollateral(noteToken.address, loan.loanId);

            /* Deposit proceeds in vault */
            await tok1.connect(accountLiquidator).transfer(vault.address, loan.liquidation);

            /* Callback vault */
            await vault
              .connect(accountLiquidator)
              .onCollateralLiquidated(noteToken.address, loan.loanId, loan.liquidation);

            /* Update balance */
            expectedCashBalance = expectedCashBalance.add(loan.liquidation);
          } else {
            /* Handle repayment */

            /* Repay loan */
            await lendingPlatform.connect(accountBorrower).repay(loan.loanId, false);

            /* Callback vault */
            await vault.onLoanRepaid(await lendingPlatform.noteToken(), loan.loanId);

            /* Update balance */
            expectedCashBalance = expectedCashBalance.add(loan.repayment);
          }

          numLoansProcessed += 1;
        });

        /* Remove expired loans */
        activeLoans = activeLoans.filter((loan) => loan.maturity > currentTimestamp);
      }

      /* Check final cash balance matches expected */
      expect((await vault.balanceState()).totalCashBalance).to.equal(expectedCashBalance);
    });
  });
});
