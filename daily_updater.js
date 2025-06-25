require('dotenv').config();
const fs = require('fs');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const JUPITER_STAKING_PROGRAM = 'voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const CLAIM_STAKE_PROGRAM = 'DiS3nNjFVMieMgmiQFm6wgJL7nevk4NrhXKLbtEH1Z2R';

// Dynamic cutoff - will be determined from existing data
let CUTOFF_DATE;
let CUTOFF_TIMESTAMP;

class EnhancedCombinedUpdater {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.helius.xyz';
        this.dailyTotals = new Map();
        this.walletActivityByDate = new Map(); // date -> Map(wallet -> {staked, withdrawn, netChange})
        this.allWallets = new Set(); // Track all wallets we've seen
    }

    async fetchTransactionsByAddress(address, beforeSignature = null, limit = 100) {
        const url = `${this.baseUrl}/v0/addresses/${address}/transactions`;
        const params = new URLSearchParams({
            'api-key': this.apiKey,
            limit: limit.toString(),
            commitment: 'finalized'
        });

        if (beforeSignature) {
            params.append('before', beforeSignature);
        }

        const response = await fetch(`${url}?${params}`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
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

    extractAmountFromTokenTransfers(tokenTransfers) {
        if (!tokenTransfers || tokenTransfers.length === 0) {
            return 0;
        }

        const jupTransfers = tokenTransfers.filter(transfer => 
            transfer.mint === JUP_MINT
        );

        if (jupTransfers.length === 0) {
            return 0;
        }

        return jupTransfers[0].tokenAmount || 0;
    }

    extractWalletFromTransaction(transaction) {
        // Get the fee payer (first signer) as the wallet address
        if (transaction.feePayer) {
            return transaction.feePayer;
        }
        
        // Fallback to first account if feePayer not available
        if (transaction.accountKeys && transaction.accountKeys.length > 0) {
            return transaction.accountKeys[0].pubkey;
        }
        
        return null;
    }

    processTransaction(transaction) {
        // Only process transactions from cutoff onwards (including the cutoff date)
        if (transaction.timestamp < CUTOFF_TIMESTAMP) {
            return false;
        }

        const date = new Date(transaction.timestamp * 1000).toISOString().split('T')[0];
        const lastCompletedDate = this.getLastCompletedDate();
        
        // Skip transactions from today (incomplete day)
        if (date > lastCompletedDate) {
            return false;
        }
        
        // Initialize daily data structures
        if (!this.dailyTotals.has(date)) {
            this.dailyTotals.set(date, {
                date: date,
                staked: 0,
                withdrawn: 0,
                netChange: 0,
                transactionCount: 0
            });
            this.walletActivityByDate.set(date, new Map());
        }

        const dayData = this.dailyTotals.get(date);
        const dayWalletActivity = this.walletActivityByDate.get(date);
        let hasStakingActivity = false;

        // Extract wallet address
        const walletAddress = this.extractWalletFromTransaction(transaction);
        if (!walletAddress) return false;

        // Initialize wallet activity for this date
        if (!dayWalletActivity.has(walletAddress)) {
            dayWalletActivity.set(walletAddress, {
                staked: 0,
                withdrawn: 0,
                netChange: 0
            });
        }

        const walletDayData = dayWalletActivity.get(walletAddress);

        if (transaction.instructions) {
            for (const instruction of transaction.instructions) {
                // Check direct Jupiter staking instructions
                if (instruction.programId === JUPITER_STAKING_PROGRAM) {
                    const parsedInstruction = this.parseInstructionData(instruction);
                    
                    if (parsedInstruction && parsedInstruction.type !== 'unknown' && parsedInstruction.type !== 'toggleMaxLock') {
                        const amount = this.extractAmountFromTokenTransfers(transaction.tokenTransfers);
                        
                        if (amount > 0) {
                            if (parsedInstruction.type === 'increaseLockedAmount') {
                                dayData.staked += amount;
                                walletDayData.staked += amount;
                            } else if (parsedInstruction.type === 'withdraw' || parsedInstruction.type === 'withdrawPartialUnstaking') {
                                dayData.withdrawn += amount;
                                walletDayData.withdrawn += amount;
                            }
                            
                            this.allWallets.add(walletAddress);
                            hasStakingActivity = true;
                        }
                    }
                }

                // Check for claim-and-stake operations (merkle distributor program)
                if (instruction.programId === CLAIM_STAKE_PROGRAM) {
                    // Check if it has inner Jupiter staking instructions
                    if (instruction.innerInstructions) {
                        for (const innerInstruction of instruction.innerInstructions) {
                            if (innerInstruction.programId === JUPITER_STAKING_PROGRAM) {
                                const parsedInner = this.parseInstructionData(innerInstruction);
                                
                                if (parsedInner && parsedInner.type === 'increaseLockedAmount') {
                                    const amount = this.extractAmountFromTokenTransfers(transaction.tokenTransfers);
                                    
                                    if (amount > 0) {
                                        dayData.staked += amount;
                                        walletDayData.staked += amount;
                                        this.allWallets.add(walletAddress);
                                        hasStakingActivity = true;
                                    }
                                }
                            }
                        }
                    }
                }

                // Check inner instructions for any other Jupiter staking calls
                if (instruction.innerInstructions) {
                    for (const innerInstruction of instruction.innerInstructions) {
                        if (innerInstruction.programId === JUPITER_STAKING_PROGRAM) {
                            const parsedInner = this.parseInstructionData(innerInstruction);
                            
                            if (parsedInner && parsedInner.type !== 'unknown' && parsedInner.type !== 'toggleMaxLock') {
                                const amount = this.extractAmountFromTokenTransfers(transaction.tokenTransfers);
                                
                                if (amount > 0) {
                                    if (parsedInner.type === 'increaseLockedAmount') {
                                        dayData.staked += amount;
                                        walletDayData.staked += amount;
                                    } else if (parsedInner.type === 'withdraw' || parsedInner.type === 'withdrawPartialUnstaking') {
                                        dayData.withdrawn += amount;
                                        walletDayData.withdrawn += amount;
                                    }
                                    
                                    this.allWallets.add(walletAddress);
                                    hasStakingActivity = true;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (hasStakingActivity) {
            dayData.transactionCount++;
            walletDayData.netChange = walletDayData.staked - walletDayData.withdrawn;
        }

        dayData.netChange = dayData.staked - dayData.withdrawn;
        return true;
    }

    calculateIncrementalWalletCounts(existingData, latestChanges) {
        if (!existingData.dailyData || existingData.dailyData.length === 0) {
            return new Map();
        }

        let latestCumulativeCount = existingData.summary.latestActiveWallets || 0;
        const results = new Map();
        const sortedChanges = latestChanges.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        for (const change of sortedChanges) {
            const dayWalletActivity = this.walletActivityByDate.get(change.date);
            
            if (dayWalletActivity && dayWalletActivity.size > 0) {
                const netJupChange = change.netChange;
                let estimatedWalletChange = 0;
                
                if (Math.abs(netJupChange) > 1000000) {
                    estimatedWalletChange = Math.round(netJupChange / 10000000);
                }
                
                const dailyActiveWallets = dayWalletActivity.size;
                const estimatedNewWallets = Math.round(dailyActiveWallets * 0.1);
                const totalEstimatedChange = Math.max(estimatedWalletChange + estimatedNewWallets, -Math.round(latestCumulativeCount * 0.01));
                
                latestCumulativeCount = Math.max(0, latestCumulativeCount + totalEstimatedChange);
            }
            
            results.set(change.date, latestCumulativeCount);
        }
        
        return results;
    }

    getLastCompletedDate() {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        return yesterday.toISOString().split('T')[0];
    }

    async fetchLatestTransactions() {
        let beforeSignature = null;
        let hasMore = true;
        let batchCount = 0;
        
        const lastCompletedDate = this.getLastCompletedDate();

        console.log(`🔄 Fetching transactions through: ${lastCompletedDate}`);

        while (hasMore) {
            const transactions = await this.fetchTransactionsByAddress(
                JUPITER_STAKING_PROGRAM, 
                beforeSignature, 
                100
            );

            if (!transactions || transactions.length === 0) {
                hasMore = false;
                break;
            }

            let processedInBatch = 0;
            
            for (const transaction of transactions) {
                const txDate = new Date(transaction.timestamp * 1000).toISOString().split('T')[0];
                
                if (txDate > lastCompletedDate) {
                    continue;
                }
                
                if (this.processTransaction(transaction)) {
                    processedInBatch++;
                }
            }

            const oldestTx = transactions[transactions.length - 1];
            
            if (oldestTx.timestamp < CUTOFF_TIMESTAMP) {
                hasMore = false;
                break;
            }

            beforeSignature = oldestTx.signature;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return this.getDailyChanges();
    }

    getDailyChanges() {
        const sortedDates = Array.from(this.dailyTotals.keys()).sort();
        return sortedDates.map(date => ({
            date: date,
            netChange: this.dailyTotals.get(date).netChange,
            staked: this.dailyTotals.get(date).staked,
            withdrawn: this.dailyTotals.get(date).withdrawn,
            transactionCount: this.dailyTotals.get(date).transactionCount,
            uniqueWalletsActive: this.walletActivityByDate.get(date).size
        }));
    }

    readExistingData(filename) {
        try {
            const jsonContent = fs.readFileSync(filename, 'utf8');
            const data = JSON.parse(jsonContent);
            
            const latestCompleteDate = new Date(data.summary.latestDate);
            CUTOFF_DATE = data.summary.latestDate + ' 00:00:00.000';
            CUTOFF_TIMESTAMP = latestCompleteDate.getTime() / 1000;
            
            return data;
        } catch (error) {
            console.error(`❌ Error reading JSON: ${error.message}`);
            return null;
        }
    }

    updateDataWithLatest(existingData, latestChanges) {
        if (!existingData || !existingData.dailyData || existingData.dailyData.length === 0) {
            console.log('❌ No existing data to update');
            return null;
        }

        // Calculate incremental wallet counts (simpler approach for daily updates)
        console.log(`\n🔄 Calculating incremental wallet counts...`);
        const incrementalWalletCounts = this.calculateIncrementalWalletCounts(existingData, latestChanges);

        // Get the latest totals from existing data
        let currentTotalStaked = existingData.summary.latestTotalStaked;
        
        const updatedData = [...existingData.dailyData];

        console.log(`\n📈 Applying changes after ${CUTOFF_DATE}:`);
        console.log(`Starting total staked: ${currentTotalStaked.toLocaleString()} JUP`);

        // Apply changes in chronological order (oldest first)
        const sortedChanges = latestChanges.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        for (const change of sortedChanges) {
            currentTotalStaked += change.netChange;
            const activeWallets = incrementalWalletCounts.get(change.date) || null;
            
            console.log(`${change.date}: ${change.netChange > 0 ? '+' : ''}${change.netChange.toLocaleString()} JUP → ${currentTotalStaked.toLocaleString()} JUP | ${activeWallets?.toLocaleString() || 'N/A'} active wallets (${change.uniqueWalletsActive} daily active)`);
            
            // Add to the beginning of array (newest first)
            updatedData.unshift({
                date: change.date,
                totalStaked: currentTotalStaked,
                activeWallets: activeWallets
            });
        }

        // Get latest values for summary
        const latestEntry = updatedData[0];

        return {
            summary: {
                totalRecords: updatedData.length,
                latestDate: latestEntry.date,
                latestTotalStaked: latestEntry.totalStaked,
                latestActiveWallets: latestEntry.activeWallets,
                oldestDate: existingData.summary.oldestDate
            },
            dailyData: updatedData
        };
    }

    saveUpdatedData(data, outputFilename) {
        fs.writeFileSync(outputFilename, JSON.stringify(data, null, 2));
        console.log(`✅ Updated: ${data.summary.latestDate} | ${data.summary.latestTotalStaked.toLocaleString()} JUP | ${data.summary.latestActiveWallets?.toLocaleString() || 'N/A'} wallets`);
        return data;
    }
}

async function updateCombinedStaking() {
    const JSON_FILENAME = 'jupiter_combined_staking.json';
    
    const updater = new EnhancedCombinedUpdater(HELIUS_API_KEY);
    
    try {
        // Step 1: Read existing combined data
        const existingData = updater.readExistingData(JSON_FILENAME);
        
        if (!existingData) {
            console.log('❌ No existing data found - please run merger first');
            return;
        }

        // Check if we need to update anything
        const lastCompletedDate = updater.getLastCompletedDate(); // Use updater instance
        const latestDate = existingData.summary.latestDate;
        
        if (latestDate >= lastCompletedDate) {
            console.log(`✅ Data is already up to date through last completed day (${lastCompletedDate})!`);
            return;
        }
        
        console.log(`🔄 Missing data from ${latestDate} through completed day ${lastCompletedDate}`);
        
        // Step 2: Fetch latest transactions
        const latestChanges = await updater.fetchLatestTransactions();
        
        console.log(`\n🔍 Found changes for ${latestChanges.length} days after cutoff`);
        
        if (latestChanges.length === 0) {
            console.log('✅ No new transactions found - data is up to date!');
            return;
        }

        // Step 3: Update data with latest changes (including proper wallet calculation)
        const updatedData = updater.updateDataWithLatest(existingData, latestChanges);
        
        if (!updatedData) {
            console.log('❌ Failed to update data');
            return;
        }
        
        // Step 4: Save updated data
        updater.saveUpdatedData(updatedData, JSON_FILENAME);
        
        return updatedData;
        
    } catch (error) {
        console.error('❌ Update failed:', error);
    }
}

if (require.main === module) {
    updateCombinedStaking();
}

module.exports = { updateCombinedStaking };