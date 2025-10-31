use crate::instructions::shared::{close_token_account, transfer_tokens};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};
use crate::error::ErrorCode;
use crate::state::*;

#[derive(Accounts)]
pub struct TakeOffer<'info> {
    pub associated_token_program: Program<'info, AssociatedToken>,

    pub token_program: Interface<'info, TokenInterface>,

    // Used to create accounts
    pub system_program: Program<'info, System>,

    #[account(mut)]
    pub taker: Signer<'info>,// receives the tokens from the vault and pays for the transaction fees

    #[account(mut)]
    pub maker: SystemAccount<'info>,

    pub token_mint_a: InterfaceAccount<'info, Mint>,

    pub token_mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = token_mint_a,
        associated_token::authority = taker,
        associated_token::token_program = token_program,
    )]
    pub taker_token_account_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = token_mint_b, // token b owned by taker
        associated_token::authority = taker, // taker is the authority of the token b account
        associated_token::token_program = token_program,
    )]
    // send tokens to maker
    pub taker_token_account_b: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = token_mint_b,
        associated_token::authority = maker,
        associated_token::token_program = token_program,
    )]
    // receive tokens the maker asked for from taker
    pub maker_token_account_b: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        close = maker, // delete the offer after both parties have received their respective tokens
        has_one = maker,
        has_one = token_mint_b,
        seeds = [b"offer", offer.id.to_le_bytes().as_ref()],
        bump = offer.bump
    )]
    // the offer on the table created by the maker and now accepted by the taker
    // to be deleted after both parties have received their respective tokens
    offer: Account<'info, Offer>,

    // where the taker will receive the funds from
    #[account(
        mut, // mutable kbecause we'll be taking tokens out of the vault
        associated_token::mint = token_mint_a,
        associated_token::authority = offer,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
}

// taker takes the offer
// tokens from vault are transferred to taker
// vault is closed
// token b from taker's account are sent to maker's
pub fn take_offer(context: Context<TakeOffer>) -> Result<()> {
    // offer owns the vault and is the signer of the transaction
    // we use offer's signer seeds to withdraw from the vault
    let offer_account_seeds = &[
        b"offer",
        &context.accounts.offer.id.to_le_bytes()[..],
        &[context.accounts.offer.bump],
    ];
    let signers_seeds = Some(&offer_account_seeds[..]);

    // Withdraw the offered tokens from the vault to the taker
    transfer_tokens(
        &context.accounts.vault,
        &context.accounts.taker_token_account_a,
        &context.accounts.vault.amount,
        &context.accounts.token_mint_a,
        &context.accounts.offer.to_account_info(),
        &context.accounts.token_program,
        signers_seeds,
    )
    .map_err(|_| ErrorCode::FailedVaultWithdrawal)?;

    // Close the vault and return the rent to the maker
    close_token_account(
        &context.accounts.vault,
        &context.accounts.taker.to_account_info(),
        &context.accounts.offer.to_account_info(),
        &context.accounts.token_program,
        signers_seeds,
    )
    .map_err(|_| ErrorCode::FailedVaultClosure)?;

    // send tokens from taker to maker
    transfer_tokens(
        &context.accounts.taker_token_account_b,
        &context.accounts.maker_token_account_b,
        &context.accounts.offer.token_b_wanted_amount,
        &context.accounts.token_mint_b,
        &context.accounts.taker.to_account_info(),
        &context.accounts.token_program,
        None,
    )
    .map_err(|_| ErrorCode::InsufficientTakerBalance)?;

    Ok(())
}
