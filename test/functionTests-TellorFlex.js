const { expect } = require("chai");
const { network, ethers } = require("hardhat");
const h = require("./helpers/helpers");
const web3 = require('web3');
const BN = ethers.BigNumber.from

describe("TellorFlex Function Tests", function () {

	let tellor;
	let token;
	let governance;
	let govSigner;
	let accounts;
	let owner;
	const STAKE_AMOUNT_USD_TARGET = web3.utils.toWei("500");
	const PRICE_TRB = web3.utils.toWei("50");
	const REQUIRED_STAKE = web3.utils.toWei((parseInt(web3.utils.fromWei(STAKE_AMOUNT_USD_TARGET)) / parseInt(web3.utils.fromWei(PRICE_TRB))).toString());
	const REPORTING_LOCK = 43200; // 12 hours
	const QUERYID1 = h.uintTob32(1)
	const QUERYID2 = h.uintTob32(2)
	const REWARD_RATE_TARGET = 60 * 60 * 24 * 30; // 30 days
	const abiCoder = new ethers.utils.AbiCoder
	const TRB_QUERY_DATA_ARGS = abiCoder.encode(["string", "string"], ["trb", "usd"])
	const TRB_QUERY_DATA = abiCoder.encode(["string", "bytes"], ["SpotPrice", TRB_QUERY_DATA_ARGS])
	const TRB_QUERY_ID = ethers.utils.keccak256(TRB_QUERY_DATA)
	const smap = {
		startDate: 0,
		stakedBalance: 1,
		lockedBalance: 2,
		rewardDebt: 3,
		reporterLastTimestamp: 4,
		reportsSubmitted: 5,
		startVoteCount: 6,
		startVoteTally: 7
	} // getStakerInfo() indices
	


	beforeEach(async function () {
		accounts = await ethers.getSigners();
		owner = accounts[0]
		const ERC20 = await ethers.getContractFactory("StakingToken");
		token = await ERC20.deploy();
		await token.deployed();
		const Governance = await ethers.getContractFactory("GovernanceMock");
		governance = await Governance.deploy();
		await governance.deployed();
		const TellorFlex = await ethers.getContractFactory("TestFlex");
		tellor = await TellorFlex.deploy(token.address, REPORTING_LOCK, STAKE_AMOUNT_USD_TARGET, PRICE_TRB);
		owner = await ethers.getSigner(await tellor.owner())
		await tellor.deployed();
		await governance.setTellorAddress(tellor.address);
		await token.mint(accounts[1].address, web3.utils.toWei("1000"));
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await hre.network.provider.request({
			method: "hardhat_impersonateAccount",
			params: [governance.address]
		}
		)

		govSigner = await ethers.getSigner(governance.address);
		await accounts[10].sendTransaction({ to: governance.address, value: ethers.utils.parseEther("1.0") });

		await tellor.connect(owner).init(governance.address)
	});

	it("constructor", async function () {
		let stakeAmount = await tellor.getStakeAmount()
		expect(stakeAmount).to.equal(REQUIRED_STAKE);
		let governanceAddress = await tellor.getGovernanceAddress()
		expect(governanceAddress).to.equal(governance.address)
		// test require: token address must not be 0
		let tokenAddress = await tellor.getTokenAddress()
		expect(tokenAddress).to.equal(token.address)
		let reportingLock = await tellor.getReportingLock()
		expect(reportingLock).to.equal(REPORTING_LOCK)
	});

	it("depositStake", async function () {
		expect(await token.balanceOf(accounts[1].address)).to.equal(web3.utils.toWei("1000"))
		expect(await token.balanceOf(accounts[2].address)).to.equal(0)
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await token.connect(accounts[2]).approve(tellor.address, web3.utils.toWei("1000"))

		// test require(token.transferFrom... when locked balance <= zero
		await h.expectThrow(tellor.connect(accounts[2]).depositStake(web3.utils.toWei("10")))

		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
		let blocky = await h.getBlock()
		expect(await token.balanceOf(accounts[1].address)).to.equal(web3.utils.toWei("990"))
		expect(await tellor.getTotalStakers()).to.equal(1)
		let stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.startDate]).to.equal(blocky.timestamp) // startDate
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("10")) // stakedBalance
		expect(stakerDetails[smap.lockedBalance]).to.equal(0) // lockedBalance
		expect(stakerDetails[smap.rewardDebt]).to.equal(0) // rewardDebt
		expect(stakerDetails[smap.reporterLastTimestamp]).to.equal(0) // reporterLastTimestamp
		expect(stakerDetails[smap.reportsSubmitted]).to.equal(0) // reportsSubmitted
		expect(stakerDetails[smap.startVoteCount]).to.equal(0) // startVoteCount
		expect(stakerDetails[smap.startVoteTally]).to.equal(0) // startVoteTally
		expect(await tellor.totalRewardDebt()).to.equal(0)
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("10"))

		// Test min value for _amount argument
		await tellor.connect(accounts[3]).depositStake(0)
		expect(await tellor.getTotalStakers()).to.equal(1)

		await tellor.connect(accounts[1]).requestStakingWithdraw(h.toWei("5"))
		// test require(token.transferFrom... when locked balance above zero
		await tellor.connect(accounts[1]).depositStake(h.toWei("10"))
		expect(await token.balanceOf(accounts[1].address)).to.equal(web3.utils.toWei("985"))
		expect(await tellor.getTotalStakers()).to.equal(1) // Ensure only unique addresses add to total stakers
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("15"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("15"))
	})

	it("removeValue", async function () {
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await tellor.connect(accounts[1]).depositStake(REQUIRED_STAKE)
		await tellor.connect(accounts[1]).submitValue(QUERYID1, h.bytes(100), 0, '0x')
		let blocky = await h.getBlock()

		expect(await tellor.getNewValueCountbyQueryId(QUERYID1)).to.equal(1)
		await h.expectThrow(tellor.connect(govSigner).removeValue(QUERYID1, 500)) // invalid value
		expect(await tellor.retrieveData(QUERYID1, blocky.timestamp)).to.equal(h.bytes(100))
		await h.expectThrow(tellor.connect(accounts[1]).removeValue(QUERYID1, blocky.timestamp)) // test require: only gov can removeValue
		await tellor.connect(govSigner).removeValue(QUERYID1, blocky.timestamp)
		expect(await tellor.getNewValueCountbyQueryId(QUERYID1)).to.equal(0)
		expect(await tellor.retrieveData(QUERYID1, blocky.timestamp)).to.equal("0x")
		await h.expectThrow(tellor.connect(govSigner).removeValue(QUERYID1, blocky.timestamp)) // test require: invalid timestamp

		// Test min/max values for _timestamp argument
		await h.advanceTime(60 * 60 * 12)
		await tellor.connect(accounts[1]).submitValue(QUERYID2, h.bytes(100), 0, '0x')
		await expect(tellor.connect(govSigner).removeValue(QUERYID2, 0)).to.be.revertedWith("invalid timestamp")
		await expect(tellor.connect(govSigner).removeValue(QUERYID2, ethers.constants.MaxUint256)).to.be.revertedWith("invalid timestamp")
	})

	it("requestStakingWithdraw", async function () {
		await h.expectThrow(tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))) // test require: can't request staking withdraw when not staked

		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("100"))
		let blocky = await h.getBlock()
		let stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.startDate]).to.equal(blocky.timestamp)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("100"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("100"))
		expect(await tellor.totalRewardDebt()).to.equal(0)
		await h.expectThrow(tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("101"))) // test require: insufficient staked balance

		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))
		blocky = await h.getBlock()
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.startDate]).to.equal(blocky.timestamp)
		expect(stakerDetails[smap.rewardDebt]).to.equal(0)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("90"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(web3.utils.toWei("10"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("90"))
		expect(await tellor.totalRewardDebt()).to.equal(0)

		// Test max/min for _amount arg
		await expect(tellor.connect(accounts[1]).requestStakingWithdraw(ethers.constants.MaxUint256)).to.be.revertedWith("insufficient staked balance")
		await tellor.connect(accounts[1]).requestStakingWithdraw(0)
		blocky = await h.getBlock()
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.startDate]).to.equal(blocky.timestamp)
		expect(stakerDetails[smap.rewardDebt]).to.equal(0)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("90"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(web3.utils.toWei("10"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("90"))
		expect(await tellor.totalRewardDebt()).to.equal(0)

		expect(await tellor.totalStakers()).to.equal(1)
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("90"))
		expect(await tellor.totalStakers()).to.equal(0)
	})

	it("slashReporter", async function () {
		await h.expectThrow(tellor.connect(accounts[2]).slashReporter(accounts[1].address, accounts[2].address)) // test require: only gov can slash reporter
		await h.expectThrow(tellor.connect(govSigner).slashReporter(accounts[1].address, accounts[2].address)) // test require: can't slash non-staked address

		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("100"))

		// Slash when lockedBalance = 0
		let stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("100"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(0)
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("100"))
		await tellor.connect(govSigner).slashReporter(accounts[1].address, accounts[2].address)
		blocky0 = await h.getBlock()
		expect(await tellor.timeOfLastAllocation()).to.equal(blocky0.timestamp)
		expect(await tellor.accumulatedRewardPerShare()).to.equal(0)
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("90"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await tellor.totalStakers()).to.equal(1) // Still one staker bc account#1 has 90 staked & stake amount is 10
		expect(await token.balanceOf(accounts[2].address)).to.equal(web3.utils.toWei("10"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("90"))

		// Slash when lockedBalance >= stakeAmount
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))
		blocky1 = await h.getBlock()
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("80"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(web3.utils.toWei("10"))
		await tellor.connect(govSigner).slashReporter(accounts[1].address, accounts[2].address)
		expect(await tellor.timeOfLastAllocation()).to.equal(blocky1.timestamp)
		expect(await tellor.accumulatedRewardPerShare()).to.equal(0)
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("80"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(web3.utils.toWei("20"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("80"))

		// Slash when 0 < lockedBalance < stakeAmount
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("5"))
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("75"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(web3.utils.toWei("5"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("75"))
		await tellor.connect(govSigner).slashReporter(accounts[1].address, accounts[2].address)
		blocky2 = await h.getBlock()
		expect(await tellor.timeOfLastAllocation()).to.equal(blocky2.timestamp)
		expect(await tellor.accumulatedRewardPerShare()).to.equal(0)
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("70"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(web3.utils.toWei("30"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("70"))

		// Slash when lockedBalance + stakedBalance < stakeAmount
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("65"))
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("5"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(web3.utils.toWei("65"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("5"))
		await h.advanceTime(604800)
		await tellor.connect(accounts[1]).withdrawStake()
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("5"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(web3.utils.toWei("0"))
		await tellor.connect(govSigner).slashReporter(accounts[1].address, accounts[2].address)
		blocky = await h.getBlock()
		expect(await tellor.timeOfLastAllocation()).to.equal(blocky.timestamp)
		expect(await tellor.accumulatedRewardPerShare()).to.equal(0)
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(0)
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await tellor.totalStakers()).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(web3.utils.toWei("35"))
		expect(await tellor.totalStakeAmount()).to.equal(0)
	})

	it("submitValue", async function () {
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("120"))

		await h.expectThrow(tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4000), 1, '0x')) // test require: wrong nonce
		await h.expectThrow(tellor.connect(accounts[2]).submitValue(QUERYID1, h.uintTob32(4000), 1, '0x')) // test require: insufficient staked balance
		await h.expectThrow(tellor.connect(accounts[1]).submitValue(h.uintTob32(101), h.uintTob32(4000), 0, '0x')) // test require: non-legacy queryId must equal hash(queryData)
		await tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.expectThrow(tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4000), 1, '0x')) // test require: still in reporting lock

		await h.advanceTime(3600) // 1 hour
		await tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4001), 1, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getTimestampIndexByTimestamp(QUERYID1, blocky.timestamp)).to.equal(1)
		expect(await tellor.getTimestampbyQueryIdandIndex(QUERYID1, 1)).to.equal(blocky.timestamp)
		expect(await tellor.getBlockNumberByTimestamp(QUERYID1, blocky.timestamp)).to.equal(blocky.number)
		expect(await tellor.retrieveData(QUERYID1, blocky.timestamp)).to.equal(h.uintTob32(4001))
		expect(await tellor.getReporterByTimestamp(QUERYID1, blocky.timestamp)).to.equal(accounts[1].address)
		expect(await tellor.timeOfLastNewValue()).to.equal(blocky.timestamp)
		expect(await tellor.getReportsSubmittedByAddress(accounts[1].address)).to.equal(2)
		expect(await tellor.getReportsSubmittedByAddressAndQueryId(accounts[1].address, QUERYID1)).to.equal(2)

		// Test submit multiple identical values w/ min _nonce
		await token.mint(accounts[2].address, h.toWei("120"))
		await token.connect(accounts[2]).approve(tellor.address, h.toWei("120"))
		await tellor.connect(accounts[2]).depositStake(web3.utils.toWei("120"))
		await tellor.connect(accounts[2]).submitValue(QUERYID1, h.uintTob32(4001), 0, '0x')
		await h.advanceTime(3600)
		await tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4001), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getTimestampIndexByTimestamp(QUERYID1, blocky.timestamp)).to.equal(3)
		expect(await tellor.getTimestampbyQueryIdandIndex(QUERYID1, 3)).to.equal(blocky.timestamp)
		expect(await tellor.getBlockNumberByTimestamp(QUERYID1, blocky.timestamp)).to.equal(blocky.number)
		expect(await tellor.retrieveData(QUERYID1, blocky.timestamp)).to.equal(h.uintTob32(4001))
		expect(await tellor.getReporterByTimestamp(QUERYID1, blocky.timestamp)).to.equal(accounts[1].address)
		expect(await tellor.timeOfLastNewValue()).to.equal(blocky.timestamp)
		expect(await tellor.getReportsSubmittedByAddress(accounts[1].address)).to.equal(3)
		expect(await tellor.getReportsSubmittedByAddressAndQueryId(accounts[1].address, QUERYID1)).to.equal(3)

		// Test max val for _nonce
		await h.advanceTime(3600)
		await expect(tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4001), ethers.constants.MaxUint256, '0x')).to.be.revertedWith("nonce must match timestamp index")
	})

	it("withdrawStake", async function () {
		await token.connect(accounts[1]).transfer(tellor.address, web3.utils.toWei("100"))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("100"))
		expect(await tellor.getTotalStakers()).to.equal(1)

		await h.expectThrow(tellor.connect(accounts[1]).withdrawStake()) // test require: reporter not locked for withdrawal
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))
		await h.expectThrow(tellor.connect(accounts[1]).withdrawStake()) // test require: 7 days didn't pass
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(h.toWei("90"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(h.toWei("10"))

		await h.advanceTime(60 * 60 * 24 * 7)
		expect(await token.balanceOf(accounts[1].address)).to.equal(h.toWei("800"))
		await tellor.connect(accounts[1]).withdrawStake()
		expect(await token.balanceOf(accounts[1].address)).to.equal(h.toWei("810"))
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(h.toWei("90"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		await h.expectThrow(tellor.connect(accounts[1]).withdrawStake()) // test require: reporter not locked for withdrawal
	})

	it("getBlockNumberByTimestamp", async function () {
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("100"))
		await tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getBlockNumberByTimestamp(QUERYID1, blocky.timestamp)).to.equal(blocky.number)
	})

	it("getCurrentValue", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		expect(await tellor.getCurrentValue(QUERYID1)).to.equal(h.uintTob32(4000))
	})

	it("getGovernanceAddress", async function () {
		expect(await tellor.getGovernanceAddress()).to.equal(governance.address)
	})

	it("getNewValueCountbyQueryId", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		expect(await tellor.getNewValueCountbyQueryId(QUERYID1)).to.equal(2)
	})

	it("getReportDetails", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky1 = await h.getBlock()
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4001), 0, '0x')
		blocky2 = await h.getBlock()
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4002), 0, '0x')
		blocky3 = await h.getBlock()
		await tellor.connect(govSigner).removeValue(QUERYID1, blocky3.timestamp)
		reportDetails = await tellor.getReportDetails(QUERYID1, blocky1.timestamp)
		expect(reportDetails[0]).to.equal(accounts[1].address)
		expect(reportDetails[1]).to.equal(false)
		reportDetails = await tellor.getReportDetails(QUERYID1, blocky2.timestamp)
		expect(reportDetails[0]).to.equal(accounts[1].address)
		expect(reportDetails[1]).to.equal(false)
		reportDetails = await tellor.getReportDetails(QUERYID1, blocky3.timestamp)
		expect(reportDetails[0]).to.equal(accounts[1].address)
		expect(reportDetails[1]).to.equal(true)
		reportDetails = await tellor.getReportDetails(h.uintTob32(2), blocky1.timestamp)
		expect(reportDetails[0]).to.equal(h.zeroAddress)
		expect(reportDetails[1]).to.equal(false)
	})

	it("getReportingLock", async function () {
		expect(await tellor.getReportingLock()).to.equal(REPORTING_LOCK)
	})

	it("getReporterByTimestamp", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		expect(await tellor.getNewValueCountbyQueryId(QUERYID1)).to.equal(1)
	})

	it("getReporterLastTimestamp", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getReporterLastTimestamp(accounts[1].address)).to.equal(blocky.timestamp)
	})

	it("getReportsSubmittedByAddress", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getReportsSubmittedByAddress(accounts[1].address)).to.equal(2)
	})

	it("getReportsSubmittedByAddressAndQueryId", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getReportsSubmittedByAddressAndQueryId(accounts[1].address, QUERYID1)).to.equal(2)
	})

	it("getStakeAmount", async function () {
		expect(await tellor.getStakeAmount()).to.equal(REQUIRED_STAKE)
	})

	it("getStakerInfo", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(h.toWei("100"))
		await tellor.requestStakingWithdraw(h.toWei("10"))
		blocky = await h.getBlock()
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky2 = await h.getBlock()
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.startDate]).to.equal(blocky.timestamp)
		expect(stakerDetails[smap.stakedBalance]).to.equal(h.toWei("90"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(h.toWei("10"))
		expect(stakerDetails[smap.rewardDebt]).to.equal(0)
		expect(stakerDetails[smap.reporterLastTimestamp]).to.equal(blocky2.timestamp)
		expect(stakerDetails[smap.reportsSubmitted]).to.equal(1)
		expect(stakerDetails[smap.startVoteCount]).to.equal(0)
		expect(stakerDetails[smap.startVoteTally]).to.equal(0)
	})

	it("getTimeOfLastNewValue", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getTimeOfLastNewValue()).to.equal(blocky.timestamp)
	})

	it("getTimestampbyQueryIdandIndex", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getTimestampbyQueryIdandIndex(QUERYID1, 1)).to.equal(blocky.timestamp)
	})

	it("getTimestampIndexByTimestamp", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getTimestampIndexByTimestamp(QUERYID1, blocky.timestamp)).to.equal(1)
	})

	it("getTotalStakeAmount", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(h.toWei("100"))
		await tellor.requestStakingWithdraw(h.toWei("10"))
		expect(await tellor.getTotalStakeAmount()).to.equal(h.toWei("90"))
	})

	it("getTokenAddress", async function () {
		expect(await tellor.getTokenAddress()).to.equal(token.address)
	})

	it("getTotalStakers", async function () {
		tellor = await tellor.connect(accounts[1])

		// Only count unique stakers
		expect(await tellor.getTotalStakers()).to.equal(0)
		await tellor.depositStake(h.toWei("100"))
		expect(await tellor.getTotalStakers()).to.equal(1)
		await tellor.depositStake(h.toWei("100"))
		expect(await tellor.getTotalStakers()).to.equal(1)

		// Unstake, restake
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("200"))
		expect(await tellor.totalStakers()).to.equal(0)
		await tellor.depositStake(h.toWei("100"))
		expect(await tellor.totalStakers()).to.equal(1)
	})

	it("retrieveData", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4001), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.retrieveData(QUERYID1, blocky.timestamp)).to.equal(h.uintTob32(4001))

		// Test max/min values for _timestamp arg
		expect(await tellor.retrieveData(QUERYID1, 0)).to.equal(ethers.utils.hexlify("0x"))
		expect(await tellor.retrieveData(QUERYID1, ethers.constants.MaxUint256)).to.equal(ethers.utils.hexlify("0x"))
	})

	it("updateTotalTimeBasedRewardsBalance", async function () {
		expect(BN(await tellor.totalTimeBasedRewardsBalance())).to.equal(0)
		await token.connect(accounts[1]).transfer(tellor.address, web3.utils.toWei("100"))
		expect(BN(await tellor.totalTimeBasedRewardsBalance())).to.equal(0)
		await tellor.connect(accounts[1]).updateTotalTimeBasedRewardsBalance()
		expect(BN(await tellor.totalTimeBasedRewardsBalance())).to.equal(web3.utils.toWei("100"))
	})

	it("addStakingRewards", async function () {
		await token.mint(accounts[2].address, h.toWei("1000"))
		await h.expectThrow(tellor.connect(accounts[2]).addStakingRewards(h.toWei("1000"))) // test require: token.transferFrom...

		await token.connect(accounts[2]).approve(tellor.address, h.toWei("1000"))
		expect(await token.balanceOf(accounts[2].address)).to.equal(h.toWei("1000"))
		await tellor.connect(accounts[2]).addStakingRewards(h.toWei("1000"))
		expect(await tellor.stakingRewardsBalance()).to.equal(h.toWei("1000"))
		expect(await token.balanceOf(accounts[2].address)).to.equal(0)
		expect(await token.balanceOf(tellor.address)).to.equal(h.toWei("1000"))
		expectedRewardRate = Math.floor(h.toWei("1000") / REWARD_RATE_TARGET)
		expect(await tellor.rewardRate()).to.equal(expectedRewardRate)

		// Test min value
		await tellor.connect(accounts[2]).addStakingRewards(0)
		expect(await tellor.stakingRewardsBalance()).to.equal(h.toWei("1000"))
		expect(await token.balanceOf(accounts[2].address)).to.equal(0)
		expect(await token.balanceOf(tellor.address)).to.equal(h.toWei("1000"))
		expectedRewardRate = Math.floor(h.toWei("1000") / REWARD_RATE_TARGET)
		expect(await tellor.rewardRate()).to.equal(expectedRewardRate)
	})

	it("getPendingRewardByStaker", async function () {
		expect(await tellor.getPendingRewardByStaker(accounts[1].address)).to.equal(0)
		await token.mint(accounts[0].address, web3.utils.toWei("1000"))
		await token.approve(tellor.address, web3.utils.toWei("1000"))
		// add staking rewards
		await tellor.addStakingRewards(web3.utils.toWei("1000"))
		expectedRewardRate = Math.floor(h.toWei("1000") / REWARD_RATE_TARGET)
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
		blocky0 = await h.getBlock()
		// advance time
		await h.advanceTime(86400 * 10)
		pendingReward = await tellor.getPendingRewardByStaker(accounts[1].address)
		blocky1 = await h.getBlock()
		expectedAccumulatedRewardPerShare = BN(blocky1.timestamp - blocky0.timestamp).mul(expectedRewardRate).div(10)
		expectedPendingReward = BN(h.toWei("10")).mul(expectedAccumulatedRewardPerShare).div(h.toWei("1"))
		expect(pendingReward).to.equal(expectedPendingReward)
		// create 2 disputes, vote on 1
		await governance.beginDisputeMock()
		await governance.beginDisputeMock()
		await governance.connect(accounts[1]).voteMock(1)
		pendingReward = await tellor.getPendingRewardByStaker(accounts[1].address)
		blocky2 = await h.getBlock()
		expectedAccumulatedRewardPerShare = BN(blocky2.timestamp - blocky0.timestamp).mul(expectedRewardRate).div(10)
		expectedPendingReward = BN(h.toWei("10")).mul(expectedAccumulatedRewardPerShare).div(h.toWei("1")).div(2)
		expect(pendingReward).to.equal(expectedPendingReward)
		expect(await tellor.getPendingRewardByStaker(accounts[2].address)).to.equal(0)
	})

	it("getIndexForDataBefore()", async function () {
		// Setup
		await token.mint(accounts[1].address, web3.utils.toWei("1000"));
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("1000"))

		await tellor.connect(accounts[1]).submitValue(QUERYID2, h.bytes(100), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.connect(accounts[1]).submitValue(QUERYID2, h.bytes(100), 1, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.connect(accounts[1]).submitValue(QUERYID2, h.bytes(100), 2, '0x')

		blocky3 = await h.getBlock()
		index = await tellor.getIndexForDataBefore(QUERYID2, blocky3.timestamp)
		expect(index[0]).to.be.true
		expect(index[1]).to.equal(1)

		// advance time one year and test
		await h.advanceTime(86400 * 365)
		index = await tellor.getIndexForDataBefore(QUERYID2, blocky3.timestamp)
		expect(index[0]).to.be.true
		expect(index[1]).to.equal(1)

		// advance time one year and test
		await h.advanceTime(86400 * 365)
		index = await tellor.getIndexForDataBefore(QUERYID2, blocky3.timestamp)
		expect(index[0]).to.be.true
		expect(index[1]).to.equal(1)

		for(i = 0; i < 100; i++) {
			await tellor.connect(accounts[1]).submitValue(QUERYID2, h.bytes(100 + i), 0, '0x')
			await h.advanceTime(60 * 60 * 12)
		}

		index = await tellor.getIndexForDataBefore(QUERYID2, blocky3.timestamp)
		expect(index[0]).to.be.true
		expect(index[1]).to.equal(1)
	})

	it("getDataBefore()", async function () {
		// Setup
		await token.mint(accounts[1].address, web3.utils.toWei("1000"));
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("1000"))

		await tellor.connect(accounts[1]).submitValue(QUERYID2, h.bytes(150), 0, '0x')
		blocky1 = await h.getBlock()
		await h.advanceTime(60 * 60 * 12)
		await tellor.connect(accounts[1]).submitValue(QUERYID2, h.bytes(160), 1, '0x')
		blocky2 = await h.getBlock()
		await h.advanceTime(60 * 60 * 12)
		await tellor.connect(accounts[1]).submitValue(QUERYID2, h.bytes(170), 2, '0x')
		blocky3 = await h.getBlock()

		dataBefore = await tellor.getDataBefore(QUERYID2, blocky3.timestamp + 1)
		expect(dataBefore[0])
		expect(dataBefore[1]).to.equal(h.bytes(170))
		expect(dataBefore[2]).to.equal(blocky3.timestamp)

		dataBefore = await tellor.getDataBefore(QUERYID2, blocky2.timestamp)
		expect(dataBefore[0])
		expect(dataBefore[1]).to.equal(h.bytes(150))
		expect(dataBefore[2]).to.equal(blocky1.timestamp)

		// advance time one year and test
		await h.advanceTime(86400 * 365)
		dataBefore = await tellor.getDataBefore(QUERYID2, blocky3.timestamp + 1)
		expect(dataBefore[0])
		expect(dataBefore[1]).to.equal(h.bytes(170))
		expect(dataBefore[2]).to.equal(blocky3.timestamp)

		// advance time one year and test
		await h.advanceTime(86400 * 365)
		dataBefore = await tellor.getDataBefore(QUERYID2, blocky3.timestamp + 1)
		expect(dataBefore[0])
		expect(dataBefore[1]).to.equal(h.bytes(170))
		expect(dataBefore[2]).to.equal(blocky3.timestamp)

		dataBefore = await tellor.getDataBefore(QUERYID2, blocky2.timestamp)
		expect(dataBefore[0])
		expect(dataBefore[1]).to.equal(h.bytes(150))
		expect(dataBefore[2]).to.equal(blocky1.timestamp)

		// submit 100 values and test
		for(i = 0; i < 100; i++) {
			await tellor.connect(accounts[1]).submitValue(QUERYID2, h.bytes(100 + i), 0, '0x')
			await h.advanceTime(60 * 60 * 12)
		}

		dataBefore = await tellor.getDataBefore(QUERYID2, blocky3.timestamp + 1)
		expect(dataBefore[0])
		expect(dataBefore[1]).to.equal(h.bytes(170))
		expect(dataBefore[2]).to.equal(blocky3.timestamp)

		dataBefore = await tellor.getDataBefore(QUERYID2, blocky2.timestamp)
		expect(dataBefore[0])
		expect(dataBefore[1]).to.equal(h.bytes(150))
		expect(dataBefore[2]).to.equal(blocky1.timestamp)
	})

	it.only("updateStakeAmount()", async function () {
		// Setup
		await token.mint(accounts[1].address, web3.utils.toWei("1000"));
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("1000"))
		

		// await tellor.connect(accounts[1]).submitValue(QUERYID2, h.bytes(150), 0, '0x')
		// blocky1 = await h.getBlock()

		await tellor.updateStakeAmount()
		expect(await tellor.stakeAmount()).to.equal(BigInt(STAKE_AMOUNT_USD_TARGET) / BigInt(PRICE_TRB) * BigInt(h.toWei("1")))

		let newTrbPrice1 = h.uintTob32(h.toWei("100"))
		await tellor.connect(accounts[1]).submitValue(TRB_QUERY_ID, newTrbPrice1, 0, TRB_QUERY_DATA)

	})
});
