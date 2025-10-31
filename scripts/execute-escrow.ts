import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import {
  getMakeOfferInstructionDataEncoder,
} from "../dist/js-client/instructions/makeOffer";
import { getTakeOfferInstructionDataEncoder } from "../dist/js-client/instructions/takeOffer";
import { TRUST_ESCROW_PROGRAM_ADDRESS } from "../dist/js-client/programs";

async function accountExists(connection: Connection, address: PublicKey): Promise<boolean> {
  const info = await connection.getAccountInfo(address);
  return info !== null;
}

function loadKeypair(filePath: string): Keypair {
  const secret = JSON.parse(readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function u64LeBufferFromBn(value: BN): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value.toString()));
  return buf;
}

async function makeOffer(): Promise<string> {
  // Build makeOffer instruction via raw encoder
  const data = Buffer.from(
    getMakeOfferInstructionDataEncoder().encode({
      id: BigInt(offerId.toString()),
      tokenAOfferedAmount: BigInt(tokenAOfferedAmount.toString()),
      tokenBWantedAmount: BigInt(tokenBWantedAmount.toString()),
    })
  );

  const keys = [
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: maker.publicKey, isSigner: true, isWritable: true },
    { pubkey: tokenMintA, isSigner: false, isWritable: false },
    { pubkey: tokenMintB, isSigner: false, isWritable: false },
    { pubkey: makerTokenAccountA, isSigner: false, isWritable: true },
    { pubkey: offerPda, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
  ];

  const ix = new TransactionInstruction({ programId, keys, data });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: maker.publicKey }).add(ix);
  tx.sign(maker);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

// ensure ATA exists before sending tokens to another party
// if it doesn't exist, create it
async function ensureATAExists(owner: PublicKey, mint: PublicKey, payer: Keypair): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const ataExists = await accountExists(connection, ata);
  if (!ataExists) {
    const tokenInstruction = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey }).add(tokenInstruction);
    tx.sign(payer);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  }
  return ata;
}

// wrap SOL before sending tokens to another party
async function wrapSol(owner: Keypair, ata: PublicKey, lamports: BN): Promise<void> {
  if (lamports.isZero()) return;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const transferIx = SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: ata, lamports: Number(lamports.toString()) });
  const syncIx = createSyncNativeInstruction(ata);
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: owner.publicKey })
    .add(transferIx)
    .add(syncIx);
  tx.sign(owner);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
}

// take offer
async function takeOffer(): Promise<string> {
  // Ensure ATAs exist for both parties for token B
  await ensureATAExists(maker.publicKey, tokenMintB, maker);
  await ensureATAExists(taker.publicKey, tokenMintB, taker);

  // Ensure taker has wrapped enough SOL for payment
  await wrapSol(taker, takerTokenAccountB, tokenBWantedAmount);

  // Ensure taker has an ATA for token A to receive tokens from the maker
  await ensureATAExists(taker.publicKey, tokenMintA, taker);

  // Build takeOffer instruction
  const data = Buffer.from(getTakeOfferInstructionDataEncoder().encode({}));
  const keys = [
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: taker.publicKey, isSigner: true, isWritable: true },
    { pubkey: maker.publicKey, isSigner: false, isWritable: true },
    { pubkey: tokenMintA, isSigner: false, isWritable: false },
    { pubkey: tokenMintB, isSigner: false, isWritable: false },
    { pubkey: takerTokenAccountA, isSigner: false, isWritable: true },
    { pubkey: takerTokenAccountB, isSigner: false, isWritable: true },
    { pubkey: makerTokenAccountB, isSigner: false, isWritable: true },
    { pubkey: offerPda, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
  ];
  // transaction instruction
  const txInstruction = new TransactionInstruction({ programId, keys, data });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: taker.publicKey }).add(txInstruction);
  tx.sign(taker); // taker signs the transaction
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

const getOfferPda = (offerId: BN) => {
  const idSeed = Buffer.alloc(8);
  idSeed.writeBigUInt64LE(BigInt(offerId.toString()));
  
  return PublicKey.findProgramAddressSync([Buffer.from("offer"), idSeed], programId)[0];
  
}

// Configure your values here
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const programId = new PublicKey(TRUST_ESCROW_PROGRAM_ADDRESS);

// load maker and taker keypairs
const maker = loadKeypair("./maker.json");
const taker = loadKeypair("./taker.json");

// Token A(maker's token) is an existing SPL token mint on devnet (env var)
const mintAPublicKeyStr = process.env.MINT_A_PUBLIC_KEY;
if (!mintAPublicKeyStr) {
  throw new Error("MINT_A_PUBLIC_KEY env var is required and should be a valid devnet SPL mint address for the maker's token");
}

// token mints A(maker's token) and B(taker's token)
const tokenMintA = new PublicKey(mintAPublicKeyStr);
const tokenMintB = NATIVE_MINT;

const offerId = new BN(10_26_433); // any unique u64 id
const tokenAOfferedAmount = new BN(50_000); // Token A offered by the maker
const tokenBWantedAmount = new BN(100_000_000); //Token B wanted by the maker


// Derive common PDAs/ATAs
const makerTokenAccountA = getAssociatedTokenAddressSync(tokenMintA, maker.publicKey);
const offerPda = getOfferPda(offerId);
const vault = getAssociatedTokenAddressSync(tokenMintA, offerPda, true);

// Taker/maker ATAs for settlement
const takerTokenAccountA = getAssociatedTokenAddressSync(tokenMintA, taker.publicKey);
const takerTokenAccountB = getAssociatedTokenAddressSync(tokenMintB, taker.publicKey);
const makerTokenAccountB = getAssociatedTokenAddressSync(tokenMintB, maker.publicKey);


async function main() {
  console.log("Maker:", maker.publicKey.toBase58());
  console.log("Taker:", taker.publicKey.toBase58());
  console.log("Token A :", tokenMintA.toBase58());
  console.log("Token B :", tokenMintB.toBase58());

  console.log("Creating offer...");
  const makeSig = await makeOffer();
  console.log("makeOffer signature:", makeSig);
  console.log("Offer PDA:", offerPda.toBase58());
  console.log("Vault ATA:", vault.toBase58());

  console.log("Taking offer...");
  const takeSig = await takeOffer();
  console.log("takeOffer signature:", takeSig);
}

main().catch((thrownObject) => {
  const error = thrownObject as Error;
  console.error(error);
  process.exit(1);
});


