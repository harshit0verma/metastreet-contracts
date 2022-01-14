import { ethers } from "hardhat";

import { IERC20Metadata } from "../typechain";

async function main() {
  const accounts = await ethers.getSigners();
  console.log("Deploying from account #9 (%s)\n", accounts[9].address);

  const TestERC20 = await ethers.getContractFactory("TestERC20", accounts[9]);
  const TestERC721 = await ethers.getContractFactory("TestERC721", accounts[9]);
  const PriceOracle = await ethers.getContractFactory("PriceOracle", accounts[9]);
  const Vault = await ethers.getContractFactory("Vault", accounts[9]);

  /* Deploy DAI */
  const daiTokenContract = await TestERC20.deploy("DAI", "DAI", 1000000);
  await daiTokenContract.deployed();
  console.log("DAI Token Contract:     ", daiTokenContract.address);

  /* Deploy WETH */
  const wethTokenContract = await TestERC20.deploy("WETH", "WETH", 1000000);
  await wethTokenContract.deployed();
  console.log("WETH Token Contract:    ", wethTokenContract.address);

  /* Deploy BAYC */
  const baycTokenContract = await TestERC721.deploy("BoredApeYachtClub", "BAYC", "ipfs://QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq/");
  await baycTokenContract.deployed();
  console.log("BAYC Token Contract:    ", baycTokenContract.address);

  console.log("");

  /* Deploy Loan Price Oracle for DAI */
  const daiPriceOracle = await PriceOracle.deploy(daiTokenContract.address);
  await daiPriceOracle.deployed();
  console.log("DAI Loan Price Oracle:  ", daiPriceOracle.address);

  /* Deploy Loan Price Oracle for WETH */
  const wethPriceOracle = await PriceOracle.deploy(wethTokenContract.address);
  await wethPriceOracle.deployed();
  console.log("WETH Loan Price Oracle: ", wethPriceOracle.address);

  console.log("");

  /* Deploy DAI Vault */
  const daiBlueChipVault = await Vault.deploy("Blue Chip / DAI", "BC", daiTokenContract.address, daiPriceOracle.address);
  await daiBlueChipVault.deployed();
  console.log("Blue Chip DAI Vault:    ", daiBlueChipVault.address);
  console.log("               Vault Name: ", await daiBlueChipVault.name());
  console.log("   Senior LP Token Symbol: ", await (await ethers.getContractAt("IERC20Metadata", await daiBlueChipVault.seniorLPToken())).symbol());
  console.log("  Senior LP Token Address: ", await daiBlueChipVault.seniorLPToken());
  console.log("   Junior LP Token Symbol: ", await (await ethers.getContractAt("IERC20Metadata", await daiBlueChipVault.juniorLPToken())).symbol());
  console.log("  Senior LP Token Address: ", await daiBlueChipVault.juniorLPToken());

  console.log("");

  /* Deploy WETH Vault */
  const wethBlueChipVault = await Vault.deploy("Blue Chip / WETH", "BC", wethTokenContract.address, wethPriceOracle.address);
  await wethBlueChipVault.deployed();
  console.log("Blue Chip WETH Vault:    ", wethBlueChipVault.address);
  console.log("               Vault Name: ", await wethBlueChipVault.name());
  console.log("   Senior LP Token Symbol: ", await (await ethers.getContractAt("IERC20Metadata", await wethBlueChipVault.seniorLPToken())).symbol());
  console.log("  Senior LP Token Address: ", await wethBlueChipVault.seniorLPToken());
  console.log("   Junior LP Token Symbol: ", await (await ethers.getContractAt("IERC20Metadata", await wethBlueChipVault.juniorLPToken())).symbol());
  console.log("  Junior LP Token Address: ", await wethBlueChipVault.juniorLPToken());

  console.log("");
  await daiTokenContract.transfer(accounts[0].address, 1000);
  console.log("Transferred 1000 DAI to account #0 (%s)", accounts[0].address);

  await wethTokenContract.transfer(accounts[0].address, 1000);
  console.log("Transferred 1000 WETH to account #0 (%s)", accounts[0].address);

  await baycTokenContract.mint(accounts[0].address, 123);
  await baycTokenContract.mint(accounts[0].address, 456);
  await baycTokenContract.mint(accounts[0].address, 768);
  console.log("Minted BAYC #123, #456, #768 to account #0 (%s)", accounts[0].address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
