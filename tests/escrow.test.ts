import { before, describe, test } from "node:test";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Program } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, Keypair, PublicKey, SystemProgram, Connection } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { expect } from "chai";

import { TrustEscrow } from "../target/types/trust_escrow";

describe("Escrow", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);
  const connection: Connection = provider.connection;

  // Anchor workspace provides the typed program client
  const program = anchor.workspace.trustEscrow as Program<TrustEscrow>;

  // Participants
  const maker = Keypair.generate();
  const taker = Keypair.generate();

  // Token mints
  let mintA: PublicKey;
  let mintB: PublicKey;

  // ATAs
  let makerTokenAccountA: PublicKey;
  let takerTokenAccountA: PublicKey;
  let takerTokenAccountB: PublicKey;
  let makerTokenAccountB: PublicKey;

  // Offer PDA and Vault ATA (derived per on-chain logic)
  const offerId = BigInt(123456); // deterministic for duplicate test
  let offerPda: PublicKey;
  let vaultAta: PublicKey;

  const tokenAOfferedAmount = BigInt(50);
  const tokenBWantedAmount = BigInt(20);

  async function airdrop(to: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  before(async () => {
    // Fund wallets
    await airdrop(maker.publicKey, 5);
    await airdrop(taker.publicKey, 5);

    // Create token mints (0 decimals for simplicity)
    mintA = await createMint(connection, maker, maker.publicKey, null, 0);
    mintB = await createMint(connection, maker, maker.publicKey, null, 0);

    // Create ATAs
    makerTokenAccountA = (await getOrCreateAssociatedTokenAccount(connection, maker, mintA, maker.publicKey)).address;
    takerTokenAccountA = getAssociatedTokenAddressSync(mintA, taker.publicKey);
    makerTokenAccountB = getAssociatedTokenAddressSync(mintB, maker.publicKey);
    takerTokenAccountB = (await getOrCreateAssociatedTokenAccount(connection, taker, mintB, taker.publicKey)).address;

    // Mint balances: maker gets A, taker gets B
    await mintTo(connection, maker, mintA, makerTokenAccountA, maker.publicKey, Number(tokenAOfferedAmount) + 10);
    await mintTo(connection, maker, mintB, takerTokenAccountB, maker.publicKey, Number(tokenBWantedAmount) + 10);

    // Derive offer PDA and vault ATA as ATA of mintA for offer PDA
    const idBuf = Buffer.alloc(8);
    idBuf.writeBigUInt64LE(offerId as bigint);
    const [offer] = PublicKey.findProgramAddressSync(
      [Buffer.from("offer"), idBuf],
      program.programId
    );
    offerPda = offer;
    vaultAta = getAssociatedTokenAddressSync(mintA, offerPda, true);
  });

  // get lamports(balance) from an account
  async function getLamports(publicKey: PublicKey): Promise<number> {
    return (await connection.getAccountInfo(publicKey))?.lamports ?? 0;
  }

  test("maker can make an offer", async () => {
    const makerABefore = (await getAccount(connection, makerTokenAccountA)).amount;

    // build and send make_offer
    await program.methods
      .makeOffer(new BN(offerId.toString()), new BN(tokenAOfferedAmount.toString()), new BN(tokenBWantedAmount.toString()))
      .accounts({
        associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        systemProgram: SystemProgram.programId,
        maker: maker.publicKey,
        tokenMintA: mintA,
        tokenMintB: mintB,
        makerTokenAccountA: makerTokenAccountA,
        offer: offerPda,
        vault: vaultAta,
      } as any)
      .signers([maker])
      .rpc({ commitment: "confirmed" });

    const makerAAfter = (await getAccount(connection, makerTokenAccountA)).amount;
    const vaultAfter = (await getAccount(connection, vaultAta)).amount;

    expect(Number(makerABefore) - Number(makerAAfter)).to.equal(Number(tokenAOfferedAmount));
    expect(Number(vaultAfter)).to.equal(Number(tokenAOfferedAmount));

    // Offer account should exist
    const offerAccount = await connection.getAccountInfo(offerPda);
    expect(offerAccount).to.not.equal(null);
  });

  test("no duplicate offers allowed", async () => {
    try {
      await program.methods
        .makeOffer(new BN(offerId.toString()), new BN(tokenAOfferedAmount.toString()), new BN(tokenBWantedAmount.toString()))
        .accounts({
          associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
          tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          systemProgram: SystemProgram.programId,
          maker: maker.publicKey,
          tokenMintA: mintA,
          tokenMintB: mintB,
          makerTokenAccountA: makerTokenAccountA,
          offer: offerPda,
          vault: vaultAta,
        } as any)
        .signers([maker])
        .rpc({ commitment: "confirmed" });
      expect.fail("Duplicate offer should have failed");
    } catch (thrownObject) {
      const error = thrownObject as Error;
      // SystemProgram allocate error when re-initting same PDA
      expect(error.message).to.include("already in use");
    }
  });

  test("taker can accept offer; balances swap and maker gets rent refunded", async () => {
    // Ensure taker has ATA for A created by program if needed; we will not pre-create it
    // Ensure maker has ATA for B; program may init it

    const makerLamportsBefore = await getLamports(maker.publicKey);
    const takerABefore = await connection.getTokenAccountBalance(takerTokenAccountA).catch(() => ({ value: { amount: "0" } }));
    const takerBBefore = await connection.getTokenAccountBalance(takerTokenAccountB);

    // Execute take_offer
    await program.methods
      .takeOffer()
      .accounts({
        associatedTokenProgram: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        systemProgram: SystemProgram.programId,
        taker: taker.publicKey,
        maker: maker.publicKey,
        tokenMintA: mintA,
        tokenMintB: mintB,
        takerTokenAccountA: getAssociatedTokenAddressSync(mintA, taker.publicKey),
        takerTokenAccountB: takerTokenAccountB,
        makerTokenAccountB: getAssociatedTokenAddressSync(mintB, maker.publicKey),
        offer: offerPda,
        vault: vaultAta,
      } as any)
      .signers([taker])
      .rpc({ commitment: "confirmed" });

    // Maker should have received token B
    const makerB = await getAccount(connection, getAssociatedTokenAddressSync(mintB, maker.publicKey));
    expect(Number(makerB.amount)).to.equal(Number(tokenBWantedAmount));

    // Taker should have received token A
    const takerA = await getAccount(connection, getAssociatedTokenAddressSync(mintA, taker.publicKey));
    expect(Number(takerA.amount) - Number(takerABefore.value.amount)).to.equal(Number(tokenAOfferedAmount));

    // Taker's token B reduced by wanted amount
    const takerBAfter = await connection.getTokenAccountBalance(takerTokenAccountB);
    expect(Number(takerBBefore.value.amount) - Number(takerBAfter.value.amount)).to.equal(Number(tokenBWantedAmount));

    // Offer account should be closed
    const offerAccountAfter = await connection.getAccountInfo(offerPda);
    expect(offerAccountAfter).to.equal(null);

    // Offer account has `close = maker`, so maker receives its rent refund and pays no fee in this tx
    const makerLamportsAfter = await getLamports(maker.publicKey);
    expect(makerLamportsAfter).to.be.greaterThan(makerLamportsBefore);
  });
});
