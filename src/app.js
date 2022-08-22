const express = require("express");
const bodyParser = require("body-parser");
const { sequelize, Contract, Job } = require("./model");
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
      '$Jobs.paid$': {[Op.eq]: null}
    },
    include: [{model: Job, as:'Jobs'}],
  });
  res.json(contracts);
});

module.exports = app;
