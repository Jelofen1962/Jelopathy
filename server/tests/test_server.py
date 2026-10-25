import importlib.util
import pathlib
import unittest
import sys

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / 'server.py'
spec = importlib.util.spec_from_file_location('jelopathy_server', MODULE_PATH)
server = importlib.util.module_from_spec(spec)
assert spec.loader
sys.modules[spec.name] = server
spec.loader.exec_module(server)

class RelayTests(unittest.TestCase):
    def setUp(self):
        self.hub = server.Hub()

    def test_vote_uses_sender_id_and_deduplicates_voter(self):
        room = 'room-a'
        candidate = server.Client('candidate', 'candidate', room)
        voter = server.Client('voter', 'voter', room)
        candidate.user = {'id': 'candidate', 'name': 'Candidate', 'color': '#000'}
        voter.user = {'id': 'voter', 'name': 'Voter', 'color': '#fff'}
        self.hub.register(candidate)
        self.hub.register(voter)
        poll = server.Poll('poll-test', room, 'candidate', 'Candidate', 1, server.time.monotonic() + 90)
        self.hub.polls[poll.poll_id] = poll
        self.hub.handle({'type': 'vote_cast', 'room_id': room, 'sender_id': 'voter', 'poll_id': poll.poll_id, 'vote': True})
        self.assertEqual(poll.votes, {'voter': True})
        self.hub.handle({'type': 'vote_cast', 'room_id': room, 'sender_id': 'voter', 'poll_id': poll.poll_id, 'vote': False})
        self.assertEqual(poll.votes, {'voter': True})
        self.assertNotIn(poll.poll_id, self.hub.polls)

    def test_request_join_empty_room_notifies_target_room(self):
        client = server.Client('one', 'one', '__join__:new-room')
        self.hub.register(client)
        self.hub.handle({'type': 'request_join', 'room_id': 'new-room', 'sender_id': 'one', 'sender_name': 'One'})
        found = []
        while not client.send_queue.empty():
            found.append(server.loads(client.send_queue.get_nowait()))
        self.assertTrue(any(item.get('type') == 'poll_result' and item.get('accepted') is True for item in found))
        self.assertIn('one', self.hub.approved_users['new-room'])

    def test_session_tokens_are_unique_and_lookup_active_client(self):
        client = server.Client('one', 'one', '__join__:room')
        self.hub.register(client)
        self.assertIs(self.hub.find_session(client.session_token), client)
        self.assertIsNone(self.hub.find_session('not-a-session'))


    def test_join_vote_approves_lobby_candidate_and_moves_no_data_early(self):
        voter = server.Client('voter-conn', 'voter', 'secure-room')
        voter.user = {'id': 'voter', 'name': 'Voter', 'color': '#fff'}
        candidate = server.Client('candidate-conn', 'candidate', '__join__:secure-room')
        self.hub.register(voter)
        self.hub.register(candidate)
        self.hub.handle({'type': 'request_join', 'room_id': 'secure-room', 'sender_id': 'candidate', 'sender_name': 'Candidate'})
        poll = next(iter(self.hub.polls.values()))
        self.hub.handle({'type': 'vote_cast', 'room_id': 'secure-room', 'sender_id': 'voter', 'poll_id': poll.poll_id, 'vote': True})
        self.assertIn('candidate', self.hub.approved_users['secure-room'])
        self.assertNotIn(poll.poll_id, self.hub.polls)
        candidate_events = []
        while not candidate.send_queue.empty():
            candidate_events.append(server.loads(candidate.send_queue.get_nowait()))
        self.assertTrue(any(event.get('type') == 'poll_result' and event.get('accepted') for event in candidate_events))

    def test_invalid_room_not_created_by_broadcast(self):
        self.hub.handle({'type': 'chat_message', 'room_id': '', 'sender_id': 'x'})
        self.assertEqual(dict(self.hub.rooms), {})

if __name__ == '__main__':
    unittest.main()
