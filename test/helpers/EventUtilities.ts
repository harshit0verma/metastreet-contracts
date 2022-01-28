import { expect } from "chai";
import { ethers } from "hardhat";

import { Contract, ContractTransaction } from "ethers";
import { LogDescription } from "@ethersproject/abi";

export async function extractEvent(
  tx: ContractTransaction,
  address: string,
  contract: Contract,
  name: string,
  index: number = 0
): Promise<LogDescription> {
  const logs = (await tx.wait()).logs;

  const eventCandidates: LogDescription[] = [];

  /* Collect all events under the name */
  for (const log of logs) {
    if (log.address != address) continue;

    const event = contract.interface.parseLog(log);
    if (event.name != name) continue;

    eventCandidates.push(event);
  }

  /* Check event exists in logs */
  if (eventCandidates.length == 0) throw new Error(`Event "${name}" from contract ${address} not found in logs`);

  /* Check event index is inbounds */
  if (index >= eventCandidates.length)
    throw new Error(`Index ${index} out of bounds for event "${name}" from contract ${address}`);

  return eventCandidates[index];
}

export async function countEvent(
  tx: ContractTransaction,
  address: string,
  contract: Contract,
  name: string
): Promise<number> {
  const logs = (await tx.wait()).logs;

  let eventCount: number = 0;

  /* Collect all events under the name */
  for (const log of logs) {
    if (log.address != address) continue;

    const event = contract.interface.parseLog(log);
    if (event.name != name) continue;

    eventCount += 1;
  }

  return eventCount;
}

export async function expectEvent(
  tx: ContractTransaction,
  address: string,
  contract: Contract,
  name: string,
  args: { [name: string]: any },
  index: number = 0
) {
  const event = await extractEvent(tx, address, contract, name, index);

  for (let argName in args) {
    expect(event.args[argName], `Mismatch of argument "${argName}" in event "${name}"`).to.equal(args[argName]);
  }
}
