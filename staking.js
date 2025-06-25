require('dotenv').config();
const fs = require('fs');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const JUPITER_STAKING_PROGRAM = 'voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

// Dynamic cutoff - will be determined from CSV data
let CUTOFF_DATE;
let CUTOFF_TIMESTAMP;

class LatestStakingUpdater {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.helius.xyz';
        this.dailyTotals = new Map();
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

    processTransaction(transaction) {
        // Only process transactions from cutoff onwards (including the cutoff date)
        if (transaction.timestamp < CUTOFF_TIMESTAMP) {
            return false;
        }

        const date = new Date(transaction.timestamp * 1000).toISOString().split('T')[0];
        
        if (!this.dailyTotals.has(date)) {
            this.dailyTotals.set(date, {
                date: date,
                staked: 0,
                withdrawn: 0,
                netChange: 0,
                transactionCount: 0
            });
        }

        const dayData = this.dailyTotals.get(date);
        let hasStakingActivity = false;

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
                            } else if (parsedInstruction.type === 'withdraw' || parsedInstruction.type === 'withdrawPartialUnstaking') {
                                dayData.withdrawn += amount;
                            }
                            hasStakingActivity = true;
                        }
                    }
                }

                // Check inner instructions for claim-and-stake
                if (instruction.innerInstructions) {
                    for (const innerInstruction of instruction.innerInstructions) {
                        if (innerInstruction.programId === JUPITER_STAKING_PROGRAM) {
                            const parsedInner = this.parseInstructionData(innerInstruction);
                            
                            if (parsedInner && parsedInner.type !== 'unknown' && parsedInner.type !== 'toggleMaxLock') {
                                const amount = this.extractAmountFromTokenTransfers(transaction.tokenTransfers);
                                
                                if (amount > 0) {
                                    if (parsedInner.type === 'increaseLockedAmount') {
                                        dayData.staked += amount;
                                    } else if (parsedInner.type === 'withdraw' || parsedInner.type === 'withdrawPartialUnstaking') {
                                        dayData.withdrawn += amount;
                                    }
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
        }

        dayData.netChange = dayData.staked - dayData.withdrawn;
        return true;
    }

    async fetchLatestTransactions() {
        let allTransactions = [];
        let beforeSignature = null;
        let hasMore = true;
        let batchCount = 0;

        console.log(`🔄 Fetching latest transactions after ${CUTOFF_DATE}...`);

        while (hasMore) {
            console.log(`Fetching batch ${++batchCount}...`);
            
            const transactions = await this.fetchTransactionsByAddress(
                JUPITER_STAKING_PROGRAM, 
                beforeSignature, 
                100
            );

            if (!transactions || transactions.length === 0) {
                console.log('No more transactions found');
                hasMore = false;
                break;
            }

            // Process each transaction
            let processedInBatch = 0;
            for (const transaction of transactions) {
                if (this.processTransaction(transaction)) {
                    processedInBatch++;
                }
            }

            console.log(`Processed ${processedInBatch} recent transactions in batch ${batchCount}`);

            const oldestTx = transactions[transactions.length - 1];
            const oldestDate = new Date(oldestTx.timestamp * 1000).toISOString().split('T')[0];
            
            // Stop if we've gone before our cutoff date
            if (oldestTx.timestamp < CUTOFF_TIMESTAMP) {
                console.log(`✅ Reached cutoff date ${CUTOFF_DATE}`);
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
            transactionCount: this.dailyTotals.get(date).transactionCount
        }));
    }

    readExistingCSV(filename) {
        try {
            const csvContent = fs.readFileSync(filename, 'utf8');
            const lines = csvContent.trim().split('\n');
            const header = lines[0].split(',');
            
            const data = [];
            for (let i = 1; i < lines.length; i++) {
                const values = lines[i].split(',');
                data.push({
                    date: values[0].split(' ')[0], // Extract just the date part
                    totalStaked: parseFloat(values[1])
                });
            }
            
            // Sort by date (newest first, same as your CSV)
            data.sort((a, b) => new Date(b.date) - new Date(a.date));
            
            console.log(`📊 Loaded ${data.length} existing records from ${filename}`);
            console.log(`📅 Latest date in CSV: ${data[0].date}`);
            console.log(`💰 Latest total: ${data[0].totalStaked.toLocaleString()} JUP`);
            
            // Calculate dynamic cutoff - the CSV date itself is the cutoff
            // If CSV shows "2025-06-24 00:00:00", we need data FROM June 24th onwards
            const latestCompleteDate = new Date(data[0].date);
            
            CUTOFF_DATE = data[0].date + ' 00:00:00.000';
            CUTOFF_TIMESTAMP = latestCompleteDate.getTime() / 1000;
            
            const today = new Date().toISOString().split('T')[0];
            const daysToUpdate = Math.ceil((new Date(today) - latestCompleteDate) / (1000 * 60 * 60 * 24)) + 1;
            
            console.log(`🔄 Dynamic cutoff set to: ${CUTOFF_DATE}`);
            console.log(`📅 Today is: ${today}`);
            console.log(`⏳ Need to fetch ~${daysToUpdate} day(s) of missing data (including ${data[0].date})`);
            console.log(`📝 Missing: ${data[0].date} through ${today}`);
            
            return data;
        } catch (error) {
            console.error(`❌ Error reading CSV: ${error.message}`);
            return [];
        }
    }

    updateDataWithLatest(existingData, latestChanges) {
        if (!existingData || existingData.length === 0) {
            console.log('❌ No existing data to update');
            return [];
        }

        // Get the latest total from existing data (should be June 24)
        let currentTotal = existingData[0].totalStaked;
        const updatedData = [...existingData];

        console.log(`\n📈 Applying changes after ${CUTOFF_DATE}:`);
        console.log(`Starting total: ${currentTotal.toLocaleString()} JUP`);

        // Apply changes in chronological order (oldest first)
        const sortedChanges = latestChanges.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        for (const change of sortedChanges) {
            currentTotal += change.netChange;
            
            console.log(`${change.date}: ${change.netChange > 0 ? '+' : ''}${change.netChange.toLocaleString()} JUP → ${currentTotal.toLocaleString()} JUP (${change.transactionCount} txs)`);
            
            // Add to the beginning of array (newest first)
            updatedData.unshift({
                date: change.date,
                totalStaked: currentTotal
            });
        }

        return updatedData;
    }

    saveUpdatedData(data, outputFilename) {
        // Save as JSON
        const jsonOutput = {
            summary: {
                totalRecords: data.length,
                latestDate: data[0].date,
                latestTotal: data[0].totalStaked,
                oldestDate: data[data.length - 1].date
            },
            dailyData: data
        };

        fs.writeFileSync(outputFilename, JSON.stringify(jsonOutput, null, 2));
        console.log(`\n💾 Updated data saved to: ${outputFilename}`);

        // Also save as CSV
        const csvFilename = outputFilename.replace('.json', '.csv');
        const csvContent = 'Snapshot Date,Total Staked Amount\n' + 
            data.map(row => `${row.date} 00:00:00.000,${row.totalStaked}`).join('\n');
        
        fs.writeFileSync(csvFilename, csvContent);
        console.log(`💾 CSV saved to: ${csvFilename}`);

        return jsonOutput;
    }
}

async function updateLatestStaking() {
    const CSV_FILENAME = 'jupiter_staking_data.csv'; // Update this to your CSV filename
    
    const updater = new LatestStakingUpdater(HELIUS_API_KEY);
    
    try {
        // Step 1: Read existing CSV data and set dynamic cutoff
        const existingData = updater.readExistingCSV(CSV_FILENAME);
        
        if (!existingData || existingData.length === 0) {
            console.log('❌ No existing data found - please check CSV filename');
            return;
        }

        // Check if we need to update anything
        const today = new Date().toISOString().split('T')[0];
        const latestDate = existingData[0].date;
        
        if (latestDate === today) {
            console.log('✅ Data is already up to date - no missing days!');
            return;
        }
        
        console.log(`🔄 Missing data from ${latestDate} onwards (including ${latestDate})`);
        
        // Step 2: Fetch latest transactions
        const latestChanges = await updater.fetchLatestTransactions();
        
        console.log(`\n🔍 Found changes for ${latestChanges.length} days after cutoff`);
        
        if (latestChanges.length === 0) {
            console.log('✅ No new transactions found - data is up to date!');
            return;
        }

        // Step 3: Update data with latest changes
        const updatedData = updater.updateDataWithLatest(existingData, latestChanges);
        
        // Step 4: Save updated data
        const result = updater.saveUpdatedData(updatedData, 'jupiter_staking_updated.json');
        
        console.log('\n🎉 === UPDATE COMPLETE ===');
        console.log(`📊 Total records: ${result.summary.totalRecords}`);
        console.log(`📅 Latest date: ${result.summary.latestDate}`);
        console.log(`🏆 Current total staked: ${result.summary.latestTotal.toLocaleString()} JUP`);
        
        return result;
        
    } catch (error) {
        console.error('❌ Update failed:', error);
    }
}

updateLatestStaking();