require('dotenv').config();
const fs = require('fs');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const JUPITER_STAKING_PROGRAM = 'voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const CLAIM_STAKE_PROGRAM = 'DiS3nNjFVMieMgmiQFm6wgJL7nevk4NrhXKLbtEH1Z2R';
const EXCLUDED_WALLETS = [];

let CUTOFF_DATE;
let CUTOFF_TIMESTAMP;

class JupiterUpdaterNew {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.helius.xyz';
        this.walletStates = new Map();
        this.walletStatesDate = null;
        this.dailyTotals = new Map();
        this.walletActivityByDate = new Map();
        this.allWallets = new Set();
        this.processedSignatures = new Set();
        this.duplicateStats = {
            totalProcessed: 0,
            duplicatesSkipped: 0,
            directStaking: 0,
            claimAndStake: 0,
            withdrawals: 0
        };
    }

    loadWalletStates() {
        try {
            const walletStatesData = JSON.parse(fs.readFileSync('wallet_states.json', 'utf8'));
            this.walletStatesDate = walletStatesData.asOfDate;
            
            for (const [address, balance] of Object.entries(walletStatesData.wallets)) {
                if (!EXCLUDED_WALLETS.includes(address)) {
                    this.walletStates.set(address, balance);
                }
            }
            
            const walletStatesTimestamp = new Date(this.walletStatesDate + 'T23:59:59Z');
            CUTOFF_DATE = this.walletStatesDate;
            CUTOFF_TIMESTAMP = walletStatesTimestamp.getTime() / 1000;
            
            return true;
        } catch (error) {
            console.error('Error loading wallet states:', error.message);
            return false;
        }
    }

    readExistingData(filename) {
        try {
            const jsonContent = fs.readFileSync(filename, 'utf8');
            const data = JSON.parse(jsonContent);
            
            const cleanedDailyData = this.removeDuplicateDates(data.dailyData);
            
            if (cleanedDailyData.length !== data.dailyData.length) {
                data.dailyData = cleanedDailyData;
                data.summary.totalRecords = cleanedDailyData.length;
                
                if (cleanedDailyData.length > 0) {
                    const latestEntry = cleanedDailyData[0];
                    data.summary.latestDate = latestEntry.date;
                    data.summary.latestTotalStaked = latestEntry.totalStaked;
                    data.summary.latestActiveWallets = latestEntry.activeWallets;
                }
            }
            
            return data;
        } catch (error) {
            console.error(`Error reading JSON: ${error.message}`);
            return null;
        }
    }

    removeDuplicateDates(dailyData) {
        const dateMap = new Map();
        
        for (const entry of dailyData) {
            const date = entry.date;
            if (!dateMap.has(date)) {
                dateMap.set(date, entry);
            } else {
                const existing = dateMap.get(date);
                if (entry.totalStaked > existing.totalStaked) {
                    dateMap.set(date, entry);
                }
            }
        }
        
        return Array.from(dateMap.values()).sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    getDateRange(startDate, endDate) {
        const dates = [];
        const current = new Date(startDate);
        const end = new Date(endDate);
        
        while (current <= end) {
            dates.push(current.toISOString().split('T')[0]);
            current.setUTCDate(current.getUTCDate() + 1);
        }
        
        return dates;
    }

    findMissingDates(existingData, targetEndDate) {
        if (!existingData || !existingData.dailyData || existingData.dailyData.length === 0) {
            return this.getDateRange(CUTOFF_DATE, targetEndDate);
        }

        const latestDate = existingData.summary.latestDate;
        const nextDay = new Date(latestDate);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        const nextDayStr = nextDay.toISOString().split('T')[0];
        
        if (nextDayStr > targetEndDate) {
            return [];
        }
        
        return this.getDateRange(nextDayStr, targetEndDate);
    }

    getTargetEndDate() {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        return yesterday.toISOString().split('T')[0];
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

    processTransaction(transaction, targetEndDate) {
        if (this.processedSignatures.has(transaction.signature)) {
            this.duplicateStats.duplicatesSkipped++;
            return false;
        }

        if (transaction.timestamp < CUTOFF_TIMESTAMP) {
            return false;
        }

        const date = new Date(transaction.timestamp * 1000).toISOString().split('T')[0];
        
        if (date > targetEndDate) {
            return false;
        }

        this.processedSignatures.add(transaction.signature);
        this.duplicateStats.totalProcessed++;
        
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

        const walletAddress = this.extractWalletFromTransaction(transaction);
        if (!walletAddress || EXCLUDED_WALLETS.includes(walletAddress)) return false;

        if (!dayWalletActivity.has(walletAddress)) {
            dayWalletActivity.set(walletAddress, {
                staked: 0,
                withdrawn: 0,
                netChange: 0
            });
        }

        const walletDayData = dayWalletActivity.get(walletAddress);
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

        let hasStakingActivity = false;
        let netWalletChange = 0;

        if (stakingInstructions.length > 0) {
            dayData.staked += totalAmount;
            walletDayData.staked += totalAmount;
            netWalletChange += totalAmount;
            hasStakingActivity = true;
            
            if (txAnalysis.type === 'claim_and_stake') {
                this.duplicateStats.claimAndStake++;
            } else {
                this.duplicateStats.directStaking++;
            }
        }

        if (withdrawInstructions.length > 0) {
            dayData.withdrawn += totalAmount;
            walletDayData.withdrawn += totalAmount;
            netWalletChange -= totalAmount;
            hasStakingActivity = true;
            this.duplicateStats.withdrawals++;
        }

        if (hasStakingActivity) {
            dayData.transactionCount++;
            walletDayData.netChange = walletDayData.staked - walletDayData.withdrawn;
            this.allWallets.add(walletAddress);
            
            if (netWalletChange !== 0) {
                const currentBalance = this.walletStates.get(walletAddress) || 0;
                const newBalance = currentBalance + netWalletChange;
                
                if (newBalance <= 0.0000009999) {
                    this.walletStates.delete(walletAddress);
                } else {
                    this.walletStates.set(walletAddress, newBalance);
                }
            }
        }

        dayData.netChange = dayData.staked - dayData.withdrawn;
        return hasStakingActivity;
    }

    async fetchTransactionsForDateRange(missingDates) {
        let beforeSignature = null;
        let hasMore = true;
        let batchCount = 0;
        
        const oldestMissingDate = missingDates[0];
        const newestMissingDate = missingDates[missingDates.length - 1];
        
        console.log(`Fetching transactions for ${missingDates.length} missing dates: ${oldestMissingDate} to ${newestMissingDate}`);

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

            for (const transaction of transactions) {
                const txDate = new Date(transaction.timestamp * 1000).toISOString().split('T')[0];
                
                if (txDate > newestMissingDate) {
                    continue;
                }
                
                this.processTransaction(transaction, newestMissingDate);
            }

            const oldestTx = transactions[transactions.length - 1];
            
            if (oldestTx.timestamp < CUTOFF_TIMESTAMP) {
                hasMore = false;
                break;
            }

            beforeSignature = oldestTx.signature;
            batchCount++;
            
            await new Promise(resolve => setTimeout(resolve, 200));
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
            activeWallets: this.walletStates.size
        }));
    }

    updateDataWithLatest(existingData, latestChanges) {
        if (!existingData || !existingData.dailyData || existingData.dailyData.length === 0) {
            return null;
        }

        let currentTotalStaked = existingData.summary.latestTotalStaked;
        const updatedData = [...existingData.dailyData];

        const sortedChanges = latestChanges.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        for (const change of sortedChanges) {
            currentTotalStaked += change.netChange;
            
            updatedData.unshift({
                date: change.date,
                totalStaked: currentTotalStaked,
                activeWallets: change.activeWallets
            });
        }

        const finalData = this.removeDuplicateDates(updatedData);
        const latestEntry = finalData[0];

        return {
            summary: {
                totalRecords: finalData.length,
                latestDate: latestEntry.date,
                latestTotalStaked: latestEntry.totalStaked,
                latestActiveWallets: latestEntry.activeWallets,
                oldestDate: existingData.summary.oldestDate
            },
            dailyData: finalData
        };
    }

    saveWalletStates(asOfDate) {
        const walletsObject = {};
        for (const [address, balance] of this.walletStates.entries()) {
            if (!EXCLUDED_WALLETS.includes(address)) {
                walletsObject[address] = balance;
            }
        }
        
        const walletStatesData = {
            asOfDate: asOfDate,
            wallets: walletsObject
        };
        
        fs.writeFileSync('wallet_states.json', JSON.stringify(walletStatesData, null, 2));
    }

    saveUpdatedData(data, outputFilename) {
        fs.writeFileSync(outputFilename, JSON.stringify(data, null, 2));
        return data;
    }

    async run() {
        if (!this.loadWalletStates()) {
            throw new Error('Failed to load wallet states');
        }
        
        const combinedData = this.readExistingData('jupiter_combined_staking.json');
        if (!combinedData) {
            throw new Error('Failed to load combined staking data');
        }
        
        const targetEndDate = this.getTargetEndDate();
        const missingDates = this.findMissingDates(combinedData, targetEndDate);
        
        if (missingDates.length === 0) {
            return combinedData;
        }
        
        const latestChanges = await this.fetchTransactionsForDateRange(missingDates);
        
        if (latestChanges.length === 0) {
            return combinedData;
        }

        const updatedData = this.updateDataWithLatest(combinedData, latestChanges);
        
        if (!updatedData) {
            return combinedData;
        }
        
        const latestProcessedDate = latestChanges[latestChanges.length - 1].date;
        this.saveWalletStates(latestProcessedDate);
        this.saveUpdatedData(updatedData, 'jupiter_combined_staking.json');
        
        console.log(`Updated ${latestChanges.length} missing dates through ${latestProcessedDate}`);
        
        return updatedData;
    }
}

async function main() {
    try {
        const updater = new JupiterUpdaterNew(HELIUS_API_KEY);
        await updater.run();
    } catch (error) {
        console.error('Daily update failed:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { JupiterUpdaterNew };