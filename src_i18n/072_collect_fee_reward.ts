import { PublicKey } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID,
  PDAUtil, PoolUtil, WhirlpoolIx
} from "@orca-so/whirlpools-sdk";
import {
  Instruction, EMPTY_INSTRUCTION, resolveOrCreateATA,
  TransactionBuilder
} from "@orca-so/common-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

//LANG:JP スクリプト実行前に環境変数定義が必要です
//LANG:EN Environment variables must be defined before script execution
// ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
// ANCHOR_WALLET=wallet.json
// WHIRLPOOL_POSITION=address_of_position

async function main() {
  //LANG:JP WhirlpoolClient 作成
  //LANG:EN Create WhirlpoolClient
  const provider = AnchorProvider.env();
  const ctx = WhirlpoolContext.withProvider(provider, ORCA_WHIRLPOOL_PROGRAM_ID);
  const client = buildWhirlpoolClient(ctx);

  console.log("endpoint:", ctx.connection.rpcEndpoint);
  console.log("wallet pubkey:", ctx.wallet.publicKey.toBase58());

  //LANG:JP 環境変数 WHIRLPOOL_POSITION からポジションのアドレスを読み込み
  //LANG:EN Retrieve the position address from the WHIRLPOOL_POSITION environment variable
  const position_address = process.env.WHIRLPOOL_POSITION;
  const position_pubkey = new PublicKey(position_address);
  console.log("position address:", position_pubkey.toBase58());

  //LANG:JP ポジション・プール取得
  //LANG:EN Get the position and the pool to which the position belongs
  const position = await client.getPosition(position_pubkey);
  const position_owner = ctx.wallet.publicKey;
  const position_mint = position.getData().positionMint;
  const position_mint_program_id = position.getPositionMintTokenProgramId();
  const position_token_account = getAssociatedTokenAddressSync(position_mint, position_owner, false, position_mint_program_id);
  const whirlpool_pubkey = position.getData().whirlpool;
  const whirlpool = await client.getPool(whirlpool_pubkey);
  const token_a = whirlpool.getTokenAInfo();
  const token_b = whirlpool.getTokenBInfo();

  //LANG:JP TickArray および Tick の取得
  //LANG:EN Get TickArray and Tick
  const tick_spacing = whirlpool.getData().tickSpacing;
  const tick_array_lower_pubkey = PDAUtil.getTickArrayFromTickIndex(position.getData().tickLowerIndex, tick_spacing, whirlpool_pubkey, ctx.program.programId).publicKey;
  const tick_array_upper_pubkey = PDAUtil.getTickArrayFromTickIndex(position.getData().tickUpperIndex, tick_spacing, whirlpool_pubkey, ctx.program.programId).publicKey;

  //LANG:JP フィーやリワードの受け取りに必要なトークンアカウントを作成
  //LANG:JP 受け取るトークンのミントアドレスを収集
  //LANG:EN Create token accounts to receive fees and rewards
  //LANG:EN Collect mint addresses of tokens to receive
  const tokens_to_be_collected = new Set<string>();
  tokens_to_be_collected.add(token_a.mint.toBase58());
  tokens_to_be_collected.add(token_b.mint.toBase58());
  whirlpool.getData().rewardInfos.map((reward_info) => {
    if (PoolUtil.isRewardInitialized(reward_info)) {
      tokens_to_be_collected.add(reward_info.mint.toBase58());
    }
  });
  //LANG:JP トークンアカウントのアドレス取得および存在しない場合の作成命令を取得
  //LANG:EN Get addresses of token accounts and get instructions to create if it does not exist
  const required_ta_ix: Instruction[] = [];
  const token_account_map = new Map<string, PublicKey>();
  for (let mint_b58 of tokens_to_be_collected) {
    const mint = new PublicKey(mint_b58);
    //LANG:JP 存在する場合は ix は EMPTY_INSTRUCTION
    //LANG:EN If present, ix is EMPTY_INSTRUCTION
    const { address, ...ix } = await resolveOrCreateATA(
      ctx.connection,
      position_owner,
      mint,
      () => ctx.fetcher.getAccountRentExempt()
    );
    required_ta_ix.push(ix);
    token_account_map.set(mint_b58, address);
  }

  //LANG:JP フィーやリワードの情報を最新化する命令を作成
  //LANG:EN Build the instruction to update fees and rewards
  let update_fee_and_rewards_ix = WhirlpoolIx.updateFeesAndRewardsIx(
    ctx.program,
    {
      whirlpool: position.getData().whirlpool,
      position: position_pubkey,
      tickArrayLower: tick_array_lower_pubkey,
      tickArrayUpper: tick_array_upper_pubkey,
    }
  );

  //LANG:JP フィー回収の命令を作成
  //LANG:EN Build the instruction to collect fees
  let collect_fees_ix = WhirlpoolIx.collectFeesIx(
    ctx.program,
    {
      whirlpool: whirlpool_pubkey,
      position: position_pubkey,
      positionAuthority: position_owner,
      positionTokenAccount: position_token_account,
      tokenOwnerAccountA: token_account_map.get(token_a.mint.toBase58()),
      tokenOwnerAccountB: token_account_map.get(token_b.mint.toBase58()),
      tokenVaultA: whirlpool.getData().tokenVaultA,
      tokenVaultB: whirlpool.getData().tokenVaultB,
    }
  );

  //LANG:JP リワード回収の命令を作成
  //LANG:EN Build the instructions to collect rewards
  const collect_reward_ix = [EMPTY_INSTRUCTION, EMPTY_INSTRUCTION, EMPTY_INSTRUCTION];
  for (let i = 0; i < whirlpool.getData().rewardInfos.length; i++) {
    const reward_info = whirlpool.getData().rewardInfos[i];
    if (!PoolUtil.isRewardInitialized(reward_info)) continue;

    collect_reward_ix[i] = WhirlpoolIx.collectRewardIx(
      ctx.program,
      {
        whirlpool: whirlpool_pubkey,
        position: position_pubkey,
        positionAuthority: position_owner,
        positionTokenAccount: position_token_account,
        rewardIndex: i,
        rewardOwnerAccount: token_account_map.get(reward_info.mint.toBase58()),
        rewardVault: reward_info.vault,
      }
    );
  }

  //LANG:JP トランザクション組み立て
  //LANG:EN Create a transaction and add the instruction
  const tx_builder = new TransactionBuilder(ctx.connection, ctx.wallet);
  //LANG:JP トークンアカウント作成
  //LANG:EN Create token accounts
  required_ta_ix.map((ix) => tx_builder.addInstruction(ix));
  //LANG:JP 更新&フィー回収&リワード回収
  //LANG:EN Update fees and rewards, collect fees, and collect rewards
  tx_builder
    .addInstruction(update_fee_and_rewards_ix)
    .addInstruction(collect_fees_ix)
    .addInstruction(collect_reward_ix[0])
    .addInstruction(collect_reward_ix[1])
    .addInstruction(collect_reward_ix[2]);

  //LANG:JP トランザクションを送信
  //LANG:EN Send the transaction
  const signature = await tx_builder.buildAndExecute();
  console.log("signature:", signature);

  //LANG:JP トランザクション完了待ち
  //LANG:EN Wait for the transaction to complete
  const latest_blockhash = await ctx.connection.getLatestBlockhash();
  await ctx.connection.confirmTransaction({ signature, ...latest_blockhash }, "confirmed");
}

main();