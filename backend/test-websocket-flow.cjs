const WebSocket = require('ws');
const https = require('https');

const REST_API_URL = 'https://zkyicpu7dd.execute-api.eu-central-1.amazonaws.com/prod';
const WEBSOCKET_URL = 'wss://ca9ubumuug.execute-api.eu-central-1.amazonaws.com/dev';

async function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'zkyicpu7dd.execute-api.eu-central-1.amazonaws.com',
      path: `/prod${path}`,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function testFullFlow() {
  console.log('=== Testing EstimateNest WebSocket Flow ===\n');

  // 1. Create a room
  console.log('1. Creating room...');
  const createResult = await makeRequest('POST', '/rooms', {
    allowAllParticipantsToReveal: true,
    deck: 'fibonacci',
  });

  if (createResult.statusCode !== 201) {
    console.error(`Failed to create room: ${createResult.statusCode}`, createResult.body);
    return;
  }

  const { shortCode, roomId } = createResult.body;
  console.log(`   Room created: ${shortCode} (ID: ${roomId})`);

  // 2. Join the room
  console.log(`\n2. Joining room ${shortCode}...`);
  const joinResult = await makeRequest('GET', `/rooms/${shortCode}?name=TestUser`);

  if (joinResult.statusCode !== 200) {
    console.error(`Failed to join room: ${joinResult.statusCode}`, joinResult.body);
    return;
  }

  const { participantId, webSocketUrl } = joinResult.body;
  console.log(`   Joined as participant: ${participantId}`);
  console.log(`   WebSocket URL: ${webSocketUrl}`);

  // 3. Connect to WebSocket
  console.log('\n3. Connecting to WebSocket...');
  const wsUrl = `${WEBSOCKET_URL}?roomId=${roomId}&participantId=${participantId}`;
  const ws = new WebSocket(wsUrl);

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('   WebSocket connected');
      resolve();
    });

    ws.on('error', (err) => {
      console.error('   WebSocket connection error:', err.message);
      reject(err);
    });

    setTimeout(() => {
      reject(new Error('WebSocket connection timeout'));
    }, 5000);
  });

  // Set up message listener
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`   Received message: ${message.type}`);
      if (message.type === 'error') {
        console.log(`   Error: ${message.payload.message}`);
      }
    } catch (e) {
      console.log(`   Received raw: ${data.toString().substring(0, 100)}`);
    }
  });

  // 4. Send a vote
  console.log('\n4. Sending vote...');
  // First we need a round ID. In real flow, moderator would create round.
  // For test, we'll try voting without roundId (should use active round or create one)
  const voteMessage = {
    type: 'vote',
    payload: {
      value: 13, // Fibonacci value
    },
  };

  ws.send(JSON.stringify(voteMessage));
  console.log('   Vote sent (value: 13)');

  // Wait a bit for response
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // 5. Try to reveal (might fail if not moderator)
  console.log('\n5. Attempting to reveal...');
  const revealMessage = {
    type: 'reveal',
    payload: {
      // roundId would be needed if we had one
    },
  };

  ws.send(JSON.stringify(revealMessage));
  console.log('   Reveal request sent');

  // Wait for responses
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log('\n6. Closing connection...');
  ws.close();

  console.log('\n=== Test completed ===');
  console.log(`Room URL: https://d2lwwlj4af3avp.cloudfront.net/${shortCode}`);
}

testFullFlow().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
