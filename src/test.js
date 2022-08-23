const request = require('supertest');
const assert = require('assert');
const express = require('express');
const app = require('./app');

describe('Contracts', () => {
  test('it should not allow for an unauthenticated user to get a contract', (done) => {
    request(app)
      .get('/contracts/2')
      .expect(401)
      .end(function(err, res) {
        if (err) done(err);
        done()
      });
  })
})
