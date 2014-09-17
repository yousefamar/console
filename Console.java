import java.awt.*;
import java.awt.event.*;
import java.util.Calendar;
import java.util.concurrent.TimeUnit;

import javax.swing.*;

@SuppressWarnings("serial")
public class Console extends JPanel implements ActionListener {

	private JTextArea consoleText = new JTextArea();
	private JTextField textField = new JTextField(100);
	private Calendar cal = Calendar.getInstance();
	private long startTime = -1;

	public Console() {
		super(new GridBagLayout());
		//setPreferredSize(new Dimension(800, 800));
		consoleText.setEditable(false);
		consoleText.setRows(15);
		consoleText.setColumns(100);
		add(new JScrollPane(consoleText));
		
		textField.addActionListener(this);
		GridBagConstraints c = new GridBagConstraints();
        c.gridy = 1;
		add(textField, c);
	}

	public void println(String text) {
		long millis = (System.currentTimeMillis()-startTime);
		long hrs = TimeUnit.MILLISECONDS.toHours(millis);
		long mins = TimeUnit.MILLISECONDS.toMinutes(millis) - TimeUnit.HOURS.toMinutes(hrs);
		long secs = TimeUnit.MILLISECONDS.toSeconds(millis) - TimeUnit.MINUTES.toSeconds(mins);
		consoleText.append("<"+hrs+":"+(mins<10?"0":"")+mins+":"+(secs<10?"0":"")+secs+"> "+text+"\n");
		consoleText.setCaretPosition(consoleText.getDocument().getLength());
	}
	
	@Override
	public void actionPerformed(ActionEvent arg0) {
		if (startTime < 0)
			startTime = System.currentTimeMillis();
		println(textField.getText());
		textField.setText("");
	}
	
	public static void main(String[] args) {
		JFrame frame = new JFrame("File Builder");
      	frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
		frame.add(new Console());
  		frame.pack();
  		frame.setResizable(false);
  		frame.setLocationRelativeTo(null);
      	frame.setVisible(true);
	}
}
