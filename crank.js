require('dotenv').config();
const fs = require('fs');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const JUPITER_STAKING_PROGRAM = 'voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const CLAIM_STAKE_PROGRAM = 'DiS3nNjFVMieMgmiQFm6wgJL7nevk4NrhXKLbtEH1Z2R';
const CRANK_WALLET = 'crankz76bWa5KE4k8G4AfRg5NfNSj9baLxyVgikxr9r';

class CrankInteractionChecker {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.helius.xyz';
        this.interactions = [];
    }

    async fetchTransactionsByAddress(address, beforeSignature = null, limit = 100, retries = 5) {
        const url = `${this.baseUrl}/v0/addresses/${address}/transactions`;
        const params = new URLSearchParams({
            'api-key': this.apiKey,
            limit: limit.toString(),
            commitment: 'finalized'
        });

        if (beforeSignature) {
            params.append('before', beforeSignature);
        }

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const response = await fetch(`${url}?${params}`);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                return await response.json();
            } catch (error) {
                if (attempt === retries) {
                    throw error;
                }
                
                const backoffDelay = Math.min(2000 * Math.pow(2, attempt), 30000);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
            }
        }
    }

    parseInstructionData(instruction) {
        if (instruction.programId !== JUPITER_STAKING_PROGRAM) {
            return null;
        }

        const data = instruction.data;
        const INSTRUCTION_PATTERNS = {
            "akdNKvmXxTg": "withdrawPartialUnstaking",
            "Xd2GMpFXgQ1": "withdraw", 
            "hXMy9aWmoGcFwgKCTXYVV": "increaseLockedAmount",
            "35nv67PJjDCyd": "toggleMaxLock",
            "akdNKv": "withdrawPartialUnstaking",
            "Xd2GMp": "withdraw",
            "hXMy9a": "increaseLockedAmount",
            "35nv67": "toggleMaxLock"
        };

        let instructionType = INSTRUCTION_PATTERNS[data];
        if (!instructionType) {
            const dataPrefix = data.substring(0, 6);
            instructionType = INSTRUCTION_PATTERNS[dataPrefix];
        }

        return { type: instructionType || 'unknown' };
    }

    extractJupTokenTransfers(tokenTransfers) {
        if (!tokenTransfers || tokenTransfers.length === 0) {
            return { totalAmount: 0, transfers: [] };
        }

        const jupTransfers = tokenTransfers.filter(transfer => 
            transfer.mint === JUP_MINT
        );

        const totalAmount = jupTransfers.reduce((sum, transfer) => 
            sum + (transfer.tokenAmount || 0), 0
        );

        return { totalAmount, transfers: jupTransfers };
    }

    extractWalletFromTransaction(transaction) {
        if (transaction.feePayer) {
            return transaction.feePayer;
        }
        
        if (transaction.accountKeys && transaction.accountKeys.length > 0) {
            return transaction.accountKeys[0].pubkey;
        }
        
        return null;
    }

    analyzeTransactionType(transaction) {
        let hasClaimAndStake = false;
        let hasDirectJupiter = false;
        let hasInnerJupiter = false;
        let jupiterInstructions = [];

        if (transaction.instructions) {
            for (const instruction of transaction.instructions) {
                if (instruction.programId === CLAIM_STAKE_PROGRAM) {
                    hasClaimAndStake = true;
                }

                if (instruction.programId === JUPITER_STAKING_PROGRAM) {
                    hasDirectJupiter = true;
                    const parsed = this.parseInstructionData(instruction);
                    if (parsed) {
                        jupiterInstructions.push({
                            type: parsed.type,
                            level: 'direct'
                        });
                    }
                }

                if (instruction.innerInstructions) {
                    for (const innerInstruction of instruction.innerInstructions) {
                        if (innerInstruction.programId === JUPITER_STAKING_PROGRAM) {
                            hasInnerJupiter = true;
                            const parsed = this.parseInstructionData(innerInstruction);
                            if (parsed) {
                                jupiterInstructions.push({
                                    type: parsed.type,
                                    level: 'inner'
                                });
                            }
                        }
                    }
                }
            }
        }

        let transactionType = 'unknown';
        let relevantInstructions = [];

        if (hasClaimAndStake) {
            transactionType = 'claim_and_stake';
            relevantInstructions = jupiterInstructions.filter(inst => inst.level === 'inner');
        } else if (hasInnerJupiter && hasDirectJupiter) {
            transactionType = 'inner_jupiter';
            relevantInstructions = jupiterInstructions.filter(inst => inst.level === 'inner');
        } else if (hasDirectJupiter) {
            transactionType = 'direct_jupiter';
            relevantInstructions = jupiterInstructions.filter(inst => inst.level === 'direct');
        } else if (hasInnerJupiter) {
            transactionType = 'inner_jupiter';
            relevantInstructions = jupiterInstructions.filter(inst => inst.level === 'inner');
        }

        return {
            type: transactionType,
            instructions: relevantInstructions,
            hasMultiplePaths: (hasClaimAndStake && hasDirectJupiter) || (hasInnerJupiter && hasDirectJupiter)
        };
    }

    formatDate(timestamp) {
        return new Date(timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    }

    formatAmount(amount) {
        return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    processTransaction(transaction) {
        const walletAddress = this.extractWalletFromTransaction(transaction);
        
        if (walletAddress !== CRANK_WALLET) {
            return false;
        }

        const txAnalysis = this.analyzeTransactionType(transaction);
        
        if (txAnalysis.type === 'unknown' || txAnalysis.instructions.length === 0) {
            return false;
        }

        const { totalAmount } = this.extractJupTokenTransfers(transaction.tokenTransfers);
        
        if (totalAmount === 0) {
            return false;
        }

        const stakingInstructions = txAnalysis.instructions.filter(inst => 
            inst.type === 'increaseLockedAmount'
        );
        const withdrawInstructions = txAnalysis.instructions.filter(inst => 
            inst.type === 'withdraw' || inst.type === 'withdrawPartialUnstaking'
        );

        let actionType = 'unknown';
        let actionAmount = 0;

        if (stakingInstructions.length > 0) {
            actionType = 'STAKE';
            actionAmount = totalAmount;
        } else if (withdrawInstructions.length > 0) {
            actionType = 'WITHDRAW';
            actionAmount = totalAmount;
        }

        if (actionType !== 'unknown') {
            this.interactions.push({
                signature: transaction.signature,
                timestamp: transaction.timestamp,
                date: new Date(transaction.timestamp * 1000).toISOString().split('T')[0],
                dateTime: this.formatDate(transaction.timestamp),
                actionType: actionType,
                amount: actionAmount,
                formattedAmount: this.formatAmount(actionAmount),
                transactionType: txAnalysis.type,
                instructions: txAnalysis.instructions.map(inst => inst.type)
            });
            
            return true;
        }

        return false;
    }

    async findAllCrankInteractions() {
        console.log(`🔍 Searching for all ${CRANK_WALLET} interactions with Jupiter staking...`);
        
        let beforeSignature = null;
        let hasMore = true;
        let batchCount = 0;
        let totalProcessed = 0;
        let oldestDate = 'N/A';

        while (hasMore) {
            const transactions = await this.fetchTransactionsByAddress(
                CRANK_WALLET,
                beforeSignature,
                100
            );

            if (!transactions || transactions.length === 0) {
                console.log(`📄 No more transactions found at batch ${batchCount}`);
                hasMore = false;
                break;
            }

            for (const transaction of transactions) {
                totalProcessed++;
                this.processTransaction(transaction);
            }

            const oldestTx = transactions[transactions.length - 1];
            oldestDate = new Date(oldestTx.timestamp * 1000).toISOString().split('T')[0];
            beforeSignature = oldestTx.signature;
            batchCount++;
            
            await new Promise(resolve => setTimeout(resolve, 300));
            
            console.log(`📦 Batch ${batchCount}: ${transactions.length} transactions, oldest: ${oldestDate}, staking interactions found: ${this.interactions.length}`);
            
            // Safety check - if we've gone very far back and found no new interactions recently
            if (batchCount > 100 && this.interactions.length === 0) {
                console.log(`⚠️  Searched ${batchCount} batches with no staking interactions. Stopping search.`);
                break;
            }
        }

        console.log(`✅ Search completed:`);
        console.log(`   Total batches processed: ${batchCount}`);
        console.log(`   Total transactions examined: ${totalProcessed}`);
        console.log(`   Jupiter staking interactions found: ${this.interactions.length}`);
        console.log(`   Oldest transaction date: ${oldestDate}`);
        
        return this.interactions.sort((a, b) => b.timestamp - a.timestamp);
    }

    printSummary() {
        console.log(`\n📊 CRANK WALLET INTERACTION SUMMARY`);
        console.log(`Wallet: ${CRANK_WALLET}`);
        console.log(`Total Jupiter Staking Interactions: ${this.interactions.length}`);
        
        if (this.interactions.length === 0) {
            console.log('No staking interactions found.');
            return;
        }

        const firstInteraction = this.interactions[this.interactions.length - 1];
        const lastInteraction = this.interactions[0];
        
        console.log(`First Interaction: ${firstInteraction.dateTime} (${firstInteraction.actionType} ${firstInteraction.formattedAmount} JUP)`);
        console.log(`Last Interaction:  ${lastInteraction.dateTime} (${lastInteraction.actionType} ${lastInteraction.formattedAmount} JUP)`);
        
        const totalStaked = this.interactions
            .filter(i => i.actionType === 'STAKE')
            .reduce((sum, i) => sum + i.amount, 0);
        
        const totalWithdrawn = this.interactions
            .filter(i => i.actionType === 'WITHDRAW')
            .reduce((sum, i) => sum + i.amount, 0);
        
        console.log(`Total Staked: ${this.formatAmount(totalStaked)} JUP`);
        console.log(`Total Withdrawn: ${this.formatAmount(totalWithdrawn)} JUP`);
        console.log(`Net Position: ${this.formatAmount(totalStaked - totalWithdrawn)} JUP`);
    }

    printDetailedInteractions() {
        console.log(`\n📋 DETAILED INTERACTION LOG`);
        console.log(`${'Date'.padEnd(12)} ${'Time'.padEnd(10)} ${'Action'.padEnd(9)} ${'Amount'.padStart(15)} ${'Type'.padEnd(15)} Signature`);
        console.log('-'.repeat(100));
        
        for (const interaction of this.interactions) {
            const date = interaction.date;
            const time = interaction.dateTime.split(' ')[1];
            const action = interaction.actionType;
            const amount = interaction.formattedAmount.padStart(15);
            const type = interaction.transactionType.padEnd(15);
            const signature = interaction.signature.substring(0, 20) + '...';
            
            console.log(`${date.padEnd(12)} ${time.padEnd(10)} ${action.padEnd(9)} ${amount} ${type} ${signature}`);
        }
    }

    saveResults() {
        const results = {
            walletAddress: CRANK_WALLET,
            searchDate: new Date().toISOString(),
            totalInteractions: this.interactions.length,
            summary: {
                firstInteraction: this.interactions.length > 0 ? this.interactions[this.interactions.length - 1] : null,
                lastInteraction: this.interactions.length > 0 ? this.interactions[0] : null,
                totalStaked: this.interactions
                    .filter(i => i.actionType === 'STAKE')
                    .reduce((sum, i) => sum + i.amount, 0),
                totalWithdrawn: this.interactions
                    .filter(i => i.actionType === 'WITHDRAW')
                    .reduce((sum, i) => sum + i.amount, 0)
            },
            interactions: this.interactions
        };
        
        const filename = `crank_interactions_${new Date().toISOString().split('T')[0]}.json`;
        fs.writeFileSync(filename, JSON.stringify(results, null, 2));
        console.log(`\n💾 Results saved to ${filename}`);
        
        return filename;
    }

    async run() {
        console.log(`🚀 Crank Interaction Checker starting: ${new Date().toISOString()}`);
        
        await this.findAllCrankInteractions();
        
        this.printSummary();
        this.printDetailedInteractions();
        this.saveResults();
        
        if (this.interactions.length > 0) {
            const firstDate = this.interactions[this.interactions.length - 1].date;
            console.log(`\n🎯 RECOMMENDATION: Consider adjusting stats from ${firstDate} onwards`);
        }
        
        console.log(`\n✅ Analysis completed: ${new Date().toISOString()}`);
    }
}

async function main() {
    try {
        const checker = new CrankInteractionChecker(HELIUS_API_KEY);
        await checker.run();
    } catch (error) {
        console.error('❌ Crank interaction check failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { CrankInteractionChecker };