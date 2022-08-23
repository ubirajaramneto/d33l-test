const request = require("supertest");
const assert = require("assert");
const express = require("express");
const app = require("./app");

describe("Contracts", () => {
  test("it should not allow for an unauthenticated user to get a contract", (done) => {
    request(app)
      .get("/contracts/2")
      .expect(401)
      .end(function (err, res) {
        if (err) return done(err);
        return done();
      });
  });

  test("it should not allow for a profile that is not part of a contract to get a contract", (done) => {
    request(app)
      .get("/contracts/2")
      .set("profile_id", "2")
      .expect(401)
      .end(function (err, res) {
        if (err) return done(err);
        return done();
      });
  });

  test("it should not allow for an invalid contract to be returned", (done) => {
    // this was a good test, it caught a bug \o/
    request(app)
      .get("/contracts/99212987")
      .set("profile_id", "2")
      .expect(404)
      .end(function (err, res) {
        if (err) return done(err);
        return done();
      });
  });

  test("it should allow for a profile to get a contract they are part of", (done) => {
    request(app)
      .get("/contracts/2")
      .set("profile_id", "6")
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err);
        return done();
      });
  });
});
