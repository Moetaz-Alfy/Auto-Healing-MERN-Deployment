const request = require('supertest');

// Point to a test Mongo instance if you wire this into CI with a real DB.
// For now this just checks the process boots and routes respond.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/testdb';

let app;

beforeAll(() => {
  app = require('./server');
});

afterAll((done) => {
  setTimeout(done, 500); // let mongoose finish any pending ops
});

describe('API smoke tests', () => {
  it('GET / returns 200', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
  });

  it('GET /live returns 200', async () => {
    const res = await request(app).get('/live');
    expect(res.statusCode).toBe(200);
  });
});
