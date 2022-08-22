const express = require("express");
const bodyParser = require("body-parser");
const { sequelize, Contract, Job, Profile } = require("./model");
const { getProfile } = require("./middleware/getProfile");
const { Op } = require("sequelize");
const app = express();
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

/**
 * FIX ME!
 * @returns contract by id
 */
app.get("/contracts/:id", getProfile, async (req, res) => {
  const currentProfileId = req.profile.dataValues.id;
  const { Contract } = req.app.get("models");
  const { id } = req.params;
  const contract = await Contract.findOne({ where: { id } });
  if (currentProfileId !== contract.contractorId) return res.status(401).end();
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
  const contracts = await Contract.findAll({
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
  res.json(contracts);
});

// NOTE: On a production system, this would be a stored procedure inside the database.
// POST /jobs/:job_id/pay - Pay for a job, a client can only pay if his balance >= the amount to pay. The amount should be moved from the client's balance to the contractor balance.
app.post("/jobs/:job_id/pay", getProfile, async (req, res) => {
  const { id, type } = req.profile.dataValues;
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
  if (job.Contract.ClientId !== id)
    return res.status(401).json({
      error: "This job does not belong to a contract you are part of",
    });
  // check if the job was already paid for
  if (job.paid)
    return res.status(422).json({error: 'job was already paid for'})
  // after that, lets check to see if the client has balance
  const clientProfile = await Profile.findOne({ where: { id } });
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

module.exports = app;
