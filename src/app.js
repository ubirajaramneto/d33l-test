const express = require("express");
const bodyParser = require("body-parser");
const { sequelize, Contract, Job, Profile } = require("./model");
const { getProfile } = require("./middleware/getProfile");
const { Op, QueryTypes } = require("sequelize");
const app = express();
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

// CONSTANTS
const MIN_LIMIT = 20;

// this query is used in multiple places
async function getUnpaidJobs(currentProfileId) {
  return await Contract.findAll({
    where: {
      [Op.or]: [
        { contractorId: currentProfileId },
        { clientId: currentProfileId },
      ],
      status: { [Op.not]: "terminated" },
      "$Jobs.paid$": { [Op.eq]: null },
    },
    include: [{ model: Job, as: "Jobs" }],
  });
}

// RAW SQL QUERIES

const bestProfessionByDateQuery =
  "SELECT\n" +
  "    sum(price),\n" +
  "    profession\n" +
  "FROM\n" +
  "    Jobs\n" +
  "INNER JOIN Contracts C\n" +
  "    on C.id = Jobs.ContractId\n" +
  "INNER JOIN Profiles P\n" +
  "    on C.ContractorId = P.id\n" +
  "WHERE\n" +
  "    paymentDate BETWEEN :start AND :end AND\n" +
  "    paid = true\n" +
  "group by profession\n" +
  "order by price desc;";

const highestPayingClientByDateQuery =
  "select\n" +
  "    sum(price) as total,\n" +
  "    ClientId,\n" +
  "    firstName,\n" +
  "    lastName\n" +
  "from Jobs\n" +
  "inner join Contracts C on C.id = Jobs.ContractId\n" +
  "inner join Profiles P on P.id = C.ClientId\n" +
  "where paymentDate BETWEEN :start AND :end AND\n" +
  "    paid = true\n" +
  "group by ClientId\n" +
  "order by total desc\n" +
  "limit :limit;";

app.get("/contracts/:id", getProfile, async (req, res) => {
  const { id: currentProfileId } = req.profile.dataValues;
  const { Contract } = req.app.get("models");
  const { id } = req.params;
  const contract = await Contract.findOne({ where: { id } });
  if (currentProfileId !== contract.ContractorId) return res.status(401).end();
  if (!contract) return res.status(404).end();
  res.json(contract);
});

// Returns a list of contracts belonging to a user (client or contractor), the list should only contain non terminated contracts.
app.get("/contracts", getProfile, async (req, res) => {
  const currentProfileId = req.profile.dataValues.id;
  const contracts = await Contract.findAll({
    where: {
      [Op.or]: [
        { contractorId: currentProfileId },
        { clientId: currentProfileId },
      ],
      status: { [Op.not]: "terminated" },
    },
  });
  res.json(contracts);
});

// GET /jobs/unpaid - Get all unpaid jobs for a user (either a client or contractor), for active contracts only.
app.get("/jobs/unpaid", getProfile, async (req, res) => {
  const currentProfileId = req.profile.dataValues.id;
  const contracts = await getUnpaidJobs(currentProfileId);
  res.json(contracts);
});

// NOTE: On a production system, this would be a stored procedure inside the database.
// POST /jobs/:job_id/pay - Pay for a job, a client can only pay if his balance >= the amount to pay. The amount should be moved from the client's balance to the contractor balance.
app.post("/jobs/:job_id/pay", getProfile, async (req, res) => {
  const { id: currentProfileId, type } = req.profile.dataValues;
  const jobId = req.params.job_id;
  // payment should only happen from client
  if (type === "contractor")
    return res.status(400).json({ error: "Contractors can not pay for work" });
  // we want to make sure that the client is paying for contract they own
  const job = await Job.findOne({
    where: {
      id: jobId,
    },
    include: [{ model: Contract, as: "Contract" }],
  });
  if (job.Contract.ClientId !== currentProfileId)
    return res.status(401).json({
      error: "This job does not belong to a contract you are part of",
    });
  // check if the job was already paid for
  if (job.paid)
    return res.status(422).json({ error: "job was already paid for" });
  // after that, lets check to see if the client has balance
  const clientProfile = await Profile.findOne({
    where: { id: currentProfileId },
  });
  if (clientProfile.balance < job.price)
    return res.status(422).json({ error: "Insuficient balance" });

  const contractorProfile = await Profile.findOne({
    where: { id: job.Contract.ContractorId },
  });

  // initialize the transaction connection
  const t = await sequelize.transaction();
  try {
    // subtract from client balance
    await Profile.update(
      {
        balance: (clientProfile.balance - job.price).toFixed(2),
      },
      {
        transaction: t,
        where: {
          id: clientProfile.id,
        },
      }
    );

    // add to contractor balance
    await Profile.update(
      {
        balance: (contractorProfile.balance + job.price).toFixed(2),
      },
      {
        transaction: t,
        where: {
          id: contractorProfile.id,
        },
      }
    );

    // mark the job as paid
    const paidJob = await Job.update(
      {
        paid: true,
        paymentDate: new Date(),
      },
      {
        transaction: t,
        where: {
          id: jobId,
        },
      }
    );

    await t.commit();
    return res.json({ status: "paid" });
  } catch (e) {
    await t.rollback();
    return res.status(500).json({ error: "payment could not be processed" });
  }
});

// NOTE: I will assume that it is the client themselves that will be depositing to their balances
// NOTE: I will assume that the client can only add to their own account
// POST /balances/deposit/:userId - Deposits money into the the the balance of a client, a client can't deposit more than 25% his total of jobs to pay. (at the deposit moment)
app.post("/balances/deposit/:userId", getProfile, async (req, res) => {
  const { id: currentProfileId, type } = req.profile.dataValues;
  const { amount } = req.body;
  const { userId } = req.params;

  // lets make sure that only clients can deposit to their accounts
  if (type !== "client")
    return res
      .status(422)
      .json({ error: "only clients can deposit to their accounts" });
  // lets make sure the client can only deposit into his own account
  if (currentProfileId.toString() !== userId)
    return res
      .status(422)
      .json({ error: "you can only deposit on your own account" });

  const unpaidJobs = await getUnpaidJobs(currentProfileId);
  const clientProfile = await Profile.findOne({
    where: { id: userId },
  });
  let totalUnpaidJobs = 0;
  unpaidJobs.map((contract) => {
    contract.Jobs.map((job) => {
      totalUnpaidJobs += job.price;
    });
  });

  if (amount > totalUnpaidJobs / 4)
    return res.status(422).json({
      error: "you can not deposit more than 25% of your total jobs to pay",
      suggestion: `you can only deposit ${(totalUnpaidJobs / 4).toFixed(
        2
      )} at the moment`,
    });

  const t = await sequelize.transaction();
  try {
    const finalAmount = (clientProfile.balance + amount).toFixed(2);
    await Profile.update(
      {
        balance: finalAmount,
      },
      {
        transaction: t,
        where: { id: currentProfileId },
      }
    );

    await t.commit();
    return res.status(200).json({ payload: { balance: finalAmount } });
  } catch (e) {
    await t.rollback();
    return res.status(500).json("could not deposit to account");
  }
});

// GET /admin/best-profession?start=<date>&end=<date> - Returns the profession that earned the most money
app.get("/admin/best-profession", async (req, res) => {
  const { start, end } = req.query;
  const result = await sequelize.query(bestProfessionByDateQuery, {
    replacements: { start: new Date(start), end: new Date(end) },
    type: QueryTypes.SELECT,
  });
  res.status(200).json({ payload: result });
});

// GET /admin/best-clients?start=<date>&end=<date>&limit=<integer> - returns the clients the paid the most for jobs in the query time period. limit query parameter should be applied, default limit is 2.
app.get("/admin/best-clients", async (req, res) => {
  const { start, end, limit = MIN_LIMIT } = req.query;
  console.log("LIMIT: ", limit);
  const result = await sequelize.query(highestPayingClientByDateQuery, {
    replacements: { start: new Date(start), end: new Date(end), limit },
    type: QueryTypes.SELECT,
  });
  res.status(200).json({ payload: result });
});

module.exports = app;
