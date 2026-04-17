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
  let roomId, shortCode, participantId;
  const messages = [];

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

  roomId = createResult.body.roomId;
  shortCode = createResult.body.shortCode;
  console.log(`   Room created: ${shortCode} (ID: ${roomId})`);

  // 2. Join the room
  console.log(`\n2. Joining room ${shortCode}...`);
  const joinResult = await makeRequest('GET', `/rooms/${shortCode}?name=TestUser`);

  if (joinResult.statusCode !== 200) {
    console.error(`Failed to join room: ${joinResult.statusCode}`, joinResult.body);
    return;
  }

  participantId = joinResult.body.participantId;
  const webSocketUrl = joinResult.body.webSocketUrl;
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
    }, 10000);
  });

  // Set up message listener
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      messages.push({ time: new Date().toISOString(), message });
      console.log(
        `   [WS Message] ${message.type || 'unknown-type'}:`,
        JSON.stringify(message).substring(0, 200)
      );
    } catch (e) {
      const raw = data.toString();
      messages.push({ time: new Date().toISOString(), raw: raw.substring(0, 200) });
      console.log(`   [WS Raw] ${raw.substring(0, 100)}`);
    }
  });

  // Wait a bit for initial messages (participant list)
  console.log('\n4. Waiting for initial messages...');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  if (messages.length === 0) {
    console.log('   No messages received yet');
  }

  // 5. Send a vote
  console.log('\n5. Sending vote...');
  const voteMessage = {
    type: 'vote',
    payload: {
      value: 13, // Fibonacci value
    },
  };

  ws.send(JSON.stringify(voteMessage));
  console.log('   Vote sent (value: 13)');

  // Wait for responses
  console.log('   Waiting for vote response...');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 6. Try to reveal (might fail if not moderator)
  console.log('\n6. Attempting to reveal...');
  const revealMessage = {
    type: 'reveal',
    payload: {
      // roundId would be needed if we had one
    },
  };

  ws.send(JSON.stringify(revealMessage));
  console.log('   Reveal request sent');

  // Wait for responses
  console.log('   Waiting for reveal response...');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log('\n7. Summary of received messages:');
  messages.forEach((msg, i) => {
    console.log(
      `   [${i + 1}] ${msg.time}: ${msg.message ? JSON.stringify(msg.message) : msg.raw}`
    );
  });

  console.log('\n8. Closing connection...');
  ws.close();

  console.log('\n=== Test completed ===');
  console.log(`Room URL: https://dev.estimatenest.net/${shortCode}`);
  console.log(`Total messages received: ${messages.length}`);
}

testFullFlow().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
